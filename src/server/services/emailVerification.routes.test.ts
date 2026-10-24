/**
 * The two "Confirm your email" routes end to end through `handle` (CSRF, error mapping, request ids) with an in-memory
 * cookie jar standing in for `next/headers`:
 *   POST /api/auth/verify-email                 public; never signs in; `redirectTo` by session; dead links → 400 + reason
 *   POST /api/auth/email-verification/resend    signed in; dev-only link without a mail provider; 422 / 429; demo
 * Both answer every other method with a JSON 405.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SeedIds, TestDb } from "@/db/test-db";
import { SESSION_COOKIE_NAME, type Role } from "@/lib/constants";

const jar = vi.hoisted(() => new Map<string, string>());
// The route kernel (`_lib/route` → the Advanced-tools gate) imports server-only modules.
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string) => {
      if (value) jar.set(name, value);
      else jar.delete(name);
    },
  }),
}));

// The setup file loaded the session module before this mock was registered: load fresh copies.
vi.resetModules();
const { eq } = await import("drizzle-orm");
const { setDbOverride } = await import("@/db/index");
const { users } = await import("@/db/schema");
const { closeTestDbs, fakeClock, makeTestDb, seedMinimalOrg } = await import("@/db/test-db");
const { clearAllRateLimits } = await import("@/server/auth/db-rate-limit");
const { signSessionToken } = await import("@/server/auth/session-token");
const verifyRoute = await import("@/app/api/auth/verify-email/route");
const resendRoute = await import("@/app/api/auth/email-verification/resend/route");
const { CONFIRM_LINK_INVALID_MESSAGE, EMAIL_ALREADY_CONFIRMED_MESSAGE } = await import("./emailVerification");

const ORIGIN = "http://localhost:3130";
const TOKEN_IN_URL = /\/verify-email\?token=([A-Za-z0-9_-]{43})/;

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db, { emailVerified: false });
  setDbOverride(db);
  await clearAllRateLimits(db);
  jar.clear();
});
afterEach(async () => {
  setDbOverride(null);
  fakeClock.reset();
  vi.unstubAllEnvs();
  await closeTestDbs();
});

async function signInAs(userId: string, role: Role, sessionVersion = 1): Promise<void> {
  jar.set(SESSION_COOKIE_NAME, await signSessionToken({ sub: userId, sv: sessionVersion, k: role === "client" ? "client" : "staff", r: role }));
}

function post(path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface Envelope<T> {
  data?: T;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

async function call<T>(handler: (req: Request, ctx: unknown) => Promise<Response>, req: Request): Promise<{ status: number; body: Envelope<T>; headers: Headers }> {
  const res = await handler(req, undefined);
  return { status: res.status, body: (await res.json()) as Envelope<T>, headers: res.headers };
}

interface SendResult {
  sent: boolean;
  reason: string | null;
  devLink?: string;
  expiresAt?: string;
}

/** A dev-only link through the resend route (vitest: NODE_ENV=test, no mail provider). */
async function devLinkFor(userId: string, role: Role): Promise<string> {
  await signInAs(userId, role);
  const res = await call<SendResult>(resendRoute.POST, post("/api/auth/email-verification/resend"));
  expect(res.status).toBe(200);
  jar.clear();
  const match = TOKEN_IN_URL.exec(res.body.data?.devLink ?? "");
  if (!match) throw new Error(`no dev link: ${JSON.stringify(res.body)}`);
  return match[1];
}

describe("POST /api/auth/verify-email", () => {
  it("signed out: confirms, signs nobody in and sends them to sign in with their email filled in", async () => {
    const token = await devLinkFor(ids.users.owner, "photographer");
    const res = await call<{ ok: boolean; email: string; signedIn: boolean; redirectTo: string }>(verifyRoute.POST, post("/api/auth/verify-email", { token }));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: true, email: ids.emails.owner, signedIn: false, redirectTo: `/login?email=${encodeURIComponent(ids.emails.owner)}` });
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
    const [row] = await db.select().from(users).where(eq(users.id, ids.users.owner));
    expect(row.emailVerifiedAt).not.toBeNull();
  });

  it("signed in: Continue goes to that person's own landing page (editors → My jobs, clients → the portal)", async () => {
    const token = await devLinkFor(ids.users.editor1, "editor");
    await signInAs(ids.users.editor1, "editor");
    const editor = await call<{ signedIn: boolean; redirectTo: string }>(verifyRoute.POST, post("/api/auth/verify-email", { token }));
    expect(editor.body.data).toMatchObject({ signedIn: true, redirectTo: "/my-jobs" });

    const clientToken = await devLinkFor(ids.users.client, "client");
    await signInAs(ids.users.client, "client");
    const client = await call<{ signedIn: boolean; redirectTo: string }>(verifyRoute.POST, post("/api/auth/verify-email", { token: clientToken }));
    expect(client.body.data).toMatchObject({ signedIn: true, redirectTo: "/portal" });
  });

  it("dead links → 400 with the plain message and the reason the page shows", async () => {
    const token = await devLinkFor(ids.users.owner, "photographer");
    await call(verifyRoute.POST, post("/api/auth/verify-email", { token }));
    const reused = await call(verifyRoute.POST, post("/api/auth/verify-email", { token }));
    expect(reused.status).toBe(400);
    expect(reused.body.error).toMatchObject({ code: "validation", message: CONFIRM_LINK_INVALID_MESSAGE, details: { reason: "already_confirmed" } });

    for (const body of [{ token: "x".repeat(43) }, { token: "tiny" }, {}, undefined]) {
      const res = await call(verifyRoute.POST, post("/api/auth/verify-email", body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error?.details).toMatchObject({ reason: "invalid" });
    }
    const malformed = await call(verifyRoute.POST, new Request(`${ORIGIN}/api/auth/verify-email`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{" }));
    expect(malformed.status).toBe(400);
  });

  it("cross-site posts are refused (CSRF) and nothing is confirmed", async () => {
    const token = await devLinkFor(ids.users.owner, "photographer");
    const res = await call(verifyRoute.POST, post("/api/auth/verify-email", { token }, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    const [row] = await db.select().from(users).where(eq(users.id, ids.users.owner));
    expect(row.emailVerifiedAt).toBeNull();
  });

  it("opening the link (GET) confirms nothing: JSON 405 for every other method", async () => {
    for (const [name, handler] of Object.entries({ GET: verifyRoute.GET, PUT: verifyRoute.PUT, PATCH: verifyRoute.PATCH, DELETE: verifyRoute.DELETE })) {
      const res = await call(handler, new Request(`${ORIGIN}/api/auth/verify-email?token=${"x".repeat(43)}`, { method: name, headers: { origin: ORIGIN } }));
      expect(res.status, name).toBe(405);
      expect(res.body.error?.code).toBe("method_not_allowed");
      expect(res.headers.get("allow")).toBe("POST");
    }
  });
});

describe("POST /api/auth/email-verification/resend", () => {
  it("signed out → 401", async () => {
    const res = await call(resendRoute.POST, post("/api/auth/email-verification/resend"));
    expect(res.status).toBe(401);
  });

  it("development without a mail provider: the dev-only link comes back (never in production)", async () => {
    await signInAs(ids.users.owner, "photographer");
    const res = await call<SendResult>(resendRoute.POST, post("/api/auth/email-verification/resend"));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ sent: false, reason: "not_configured", expiresAt: "2026-10-09T00:00:00.000Z" });
    expect(res.body.data?.devLink).toMatch(new RegExp(`^${ORIGIN}/verify-email\\?token=`));

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "test-secret-test-secret-test-secret-test-secret");
    const prod = await call<SendResult>(resendRoute.POST, post("/api/auth/email-verification/resend"));
    expect(prod.status).toBe(200);
    expect(prod.body.data).toEqual({ sent: false, reason: "not_configured" });
  });

  it("already confirmed → 422; the 6th request in an hour → 429 with retry-after", async () => {
    await signInAs(ids.users.editor1, "editor");
    for (let i = 0; i < 5; i += 1) expect((await call(resendRoute.POST, post("/api/auth/email-verification/resend"))).status).toBe(200);
    const limited = await call(resendRoute.POST, post("/api/auth/email-verification/resend"));
    expect(limited.status).toBe(429);
    expect(limited.body.error).toMatchObject({ code: "rate_limited", details: { retryAfterSeconds: 3600 } });
    expect(limited.headers.get("retry-after")).toBe("3600");

    await db.update(users).set({ emailVerifiedAt: "2026-10-08T00:00:00.000Z" }).where(eq(users.id, ids.users.editor2));
    await signInAs(ids.users.editor2, "editor");
    const confirmed = await call(resendRoute.POST, post("/api/auth/email-verification/resend"));
    expect(confirmed.status).toBe(422);
    expect(confirmed.body.error).toMatchObject({ code: "validation", message: EMAIL_ALREADY_CONFIRMED_MESSAGE });
  });

  it("demo studio → reason demo, no link", async () => {
    const demoDb = await makeTestDb();
    const demo = await seedMinimalOrg(demoDb, { isDemo: true, emailVerified: false });
    setDbOverride(demoDb);
    await signInAs(demo.users.owner, "photographer");
    const res = await call<SendResult>(resendRoute.POST, post("/api/auth/email-verification/resend"));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sent: false, reason: "demo" });
  });

  it("a stale session (password changed elsewhere) → 401", async () => {
    await signInAs(ids.users.owner, "photographer", 7);
    expect((await call(resendRoute.POST, post("/api/auth/email-verification/resend"))).status).toBe(401);
  });

  it("JSON 405 for every other method", async () => {
    for (const [name, handler] of Object.entries({ GET: resendRoute.GET, PUT: resendRoute.PUT, PATCH: resendRoute.PATCH, DELETE: resendRoute.DELETE })) {
      const res = await call(handler, new Request(`${ORIGIN}/api/auth/email-verification/resend`, { method: name, headers: { origin: ORIGIN } }));
      expect(res.status, name).toBe(405);
    }
  });
});
