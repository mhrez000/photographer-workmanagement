/**
 * The My-account route handlers (src/app/api/auth/{email-change,email-change/resend,email-change/cancel,
 * email-change/confirm,set-password,sign-out-others}/route.ts): session gate, CSRF, JSON 405, the response shapes
 * (`{ data }` / `{ error }`) and the cookie. Driven with real `Request`s against an in-memory cookie jar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SeedIds, TestDb } from "@/db/test-db";
import type { EmailMessage, SendEmailResult } from "@/server/email";
import { SESSION_COOKIE_NAME } from "@/lib/constants";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string) => {
      if (value) jar.set(name, value);
      else jar.delete(name);
    },
  }),
}));
// The route files share `_lib/route` (→ the Advanced gate → src/server/page.ts, which is `server-only`).
vi.mock("server-only", () => ({}));

vi.resetModules();
const { eq } = await import("drizzle-orm");
const { setDbOverride } = await import("@/db/index");
const schema = await import("@/db/schema");
const { contextFor, fakeClock, makeTestDb, seedMinimalOrg, TEST_PASSWORD } = await import("@/db/test-db");
const { DEMO_BLOCKED_MESSAGES } = await import("@/server/auth/demo");
const { signSessionToken, verifySessionToken } = await import("@/server/auth/session");
const { requestEmailChange } = await import("./account");
const emailChange = await import("@/app/api/auth/email-change/route");
const resend = await import("@/app/api/auth/email-change/resend/route");
const cancel = await import("@/app/api/auth/email-change/cancel/route");
const confirm = await import("@/app/api/auth/email-change/confirm/route");
const setPasswordRoute = await import("@/app/api/auth/set-password/route");
const signOutOthers = await import("@/app/api/auth/sign-out-others/route");

const ORIGIN = "http://localhost:3130";
const CONFIGURED = { RESEND_API_KEY: "re_test", EMAIL_FROM: "Proofline <hello@example.com>", NODE_ENV: "test" };
const NEW_EMAIL = "route.change@elsewhere.test";

type Handler = (req: Request, context: unknown) => Promise<Response>;

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
  setDbOverride(db);
  jar.clear();
});
afterEach(() => {
  setDbOverride(null);
  fakeClock.reset();
});

function post(path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", "user-agent": "vitest-routes", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call(handler: Handler, req: Request): Promise<{ status: number; body: { data?: Record<string, unknown>; error?: { code: string; message: string; details?: Record<string, unknown> } } }> {
  const res = await handler(req, {});
  return { status: res.status, body: (await res.json()) as never };
}

/** This browser signed in as `userId`, `minutesAgo` minutes ago (the cookie's `at`; null = a cookie without one). */
async function signInAs(userId: string, minutesAgo: number | null = 1): Promise<string> {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  const at = minutesAgo === null ? undefined : Math.floor(Date.parse(fakeClock.now()) / 1000) - minutesAgo * 60;
  const token = await signSessionToken({ sub: row.id, sv: row.sessionVersion, k: row.role === "client" ? "client" : "staff", r: row.role, ...(at ? { at } : {}) });
  jar.set(SESSION_COOKIE_NAME, token);
  return token;
}

/** A waiting change for `userId` (email set up through the service seam); returns the plain token. */
async function pendingToken(userId: string, newEmail = NEW_EMAIL): Promise<string> {
  const messages: EmailMessage[] = [];
  const send = vi.fn(async (m: EmailMessage): Promise<SendEmailResult> => {
    messages.push(m);
    return { ok: true, provider: "resend" };
  });
  await requestEmailChange(db, await contextFor(db, userId), { newEmail, password: TEST_PASSWORD }, { email: { env: CONFIGURED, send } });
  const m = /\/change-email\?token=([A-Za-z0-9_-]+)/.exec(messages[0]?.text ?? "");
  if (!m) throw new Error("no link");
  return m[1];
}

describe("session gate, CSRF and methods", () => {
  it.each([
    ["email-change", emailChange.POST, { newEmail: NEW_EMAIL, password: TEST_PASSWORD }],
    ["email-change/resend", resend.POST, undefined],
    ["email-change/cancel", cancel.POST, undefined],
    ["set-password", setPasswordRoute.POST, { password: "A long new password" }],
    ["sign-out-others", signOutOthers.POST, undefined],
  ] as const)("POST /api/auth/%s needs a session (401)", async (path, handler, body) => {
    const { status, body: json } = await call(handler as Handler, post(`/api/auth/${path}`, body));
    expect(status).toBe(401);
    expect(json.error?.code).toBe("unauthorized");
  });

  it("a cross-site POST is refused before anything runs (403)", async () => {
    await signInAs(ids.users.owner);
    const before = (await db.select().from(schema.users).where(eq(schema.users.id, ids.users.owner)))[0];
    const { status } = await call(signOutOthers.POST as Handler, post("/api/auth/sign-out-others", undefined, { origin: "https://evil.example" }));
    expect(status).toBe(403);
    const after = (await db.select().from(schema.users).where(eq(schema.users.id, ids.users.owner)))[0];
    expect(after.sessionVersion).toBe(before.sessionVersion);
  });

  it("every other method is a JSON 405", async () => {
    for (const mod of [emailChange, resend, cancel, confirm, setPasswordRoute, signOutOthers]) {
      const res = await (mod.GET as Handler)(new Request(`${ORIGIN}/api/auth/x`), {});
      expect(res.status).toBe(405);
      expect(((await res.json()) as { error: { code: string } }).error).toBeTruthy();
    }
  });
});

describe("POST /api/auth/email-change (+ resend, cancel)", () => {
  it("without email set up the change applies at once: { status: 'changed', email }", async () => {
    await signInAs(ids.users.editor1);
    const { status, body } = await call(emailChange.POST as Handler, post("/api/auth/email-change", { newEmail: NEW_EMAIL, password: TEST_PASSWORD }));
    expect(status).toBe(200);
    expect(body.data).toEqual({ status: "changed", email: NEW_EMAIL });
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, ids.users.editor1));
    expect(row).toMatchObject({ email: NEW_EMAIL, emailVerifiedAt: null });
    const [event] = await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.eventType, "user.email_changed"));
    expect(event.metadata).toMatchObject({ via: "direct", userAgent: "vitest-routes" });
  });

  it("wrong password → 400 with fieldErrors.password; unknown body keys never reach the service", async () => {
    await signInAs(ids.users.owner);
    const { status, body } = await call(emailChange.POST as Handler, post("/api/auth/email-change", { newEmail: NEW_EMAIL, password: "nope nope nope", ip: "1.2.3.4" }));
    expect(status).toBe(400);
    expect(body.error?.code).toBe("validation");
    expect((body.error?.details as { fieldErrors: Record<string, string[]> }).fieldErrors.password).toBeTruthy();
  });

  it("6th request in an hour → 429 with retry-after", async () => {
    await signInAs(ids.users.owner);
    for (let i = 0; i < 5; i += 1) await call(emailChange.POST as Handler, post("/api/auth/email-change", { newEmail: NEW_EMAIL, password: `wrong ${i} password` }));
    const res = await (emailChange.POST as Handler)(post("/api/auth/email-change", { newEmail: NEW_EMAIL, password: TEST_PASSWORD }), {});
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    const json = (await res.json()) as { error: { details: { retryAfterSeconds: number } } };
    expect(json.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("resend with nothing waiting → 422; cancel → { cancelled }", async () => {
    await pendingToken(ids.users.owner);
    await signInAs(ids.users.owner);
    const cancelled = await call(cancel.POST as Handler, post("/api/auth/email-change/cancel"));
    expect(cancelled).toEqual({ status: 200, body: { data: { cancelled: 1 } } });
    const again = await call(resend.POST as Handler, post("/api/auth/email-change/resend"));
    expect(again.status).toBe(422);
    expect(again.body.error?.code).toBe("validation");
  });

  it("the demo studio answers 403 with the plain copy", async () => {
    const demoDb = await makeTestDb();
    const demo = await seedMinimalOrg(demoDb, { isDemo: true });
    setDbOverride(demoDb);
    const [row] = await demoDb.select().from(schema.users).where(eq(schema.users.id, demo.users.owner));
    jar.set(SESSION_COOKIE_NAME, await signSessionToken({ sub: row.id, sv: row.sessionVersion, k: "staff", r: "photographer" }));
    for (const [handler, path, body, message] of [
      [emailChange.POST, "/api/auth/email-change", { newEmail: NEW_EMAIL, password: TEST_PASSWORD }, DEMO_BLOCKED_MESSAGES.email],
      [setPasswordRoute.POST, "/api/auth/set-password", { password: "A long new password" }, DEMO_BLOCKED_MESSAGES.password],
      [signOutOthers.POST, "/api/auth/sign-out-others", undefined, DEMO_BLOCKED_MESSAGES.sessions],
    ] as const) {
      const { status, body: json } = await call(handler as Handler, post(path, body));
      expect(status, path).toBe(403);
      expect(json.error?.message).toBe(message);
    }
  });
});

describe("POST /api/auth/email-change/confirm (public)", () => {
  it("signed out: confirms and sends the person to sign in with the new address", async () => {
    const token = await pendingToken(ids.users.owner);
    const { status, body } = await call(confirm.POST as Handler, post("/api/auth/email-change/confirm", { token }));
    expect(status).toBe(200);
    expect(body.data).toEqual({ ok: true, email: NEW_EMAIL, signedIn: false, redirectTo: `/login?email=${encodeURIComponent(NEW_EMAIL)}` });
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false); // never signs anyone in
  });

  it("signed in as the same person → back to My account; as someone else → their own landing page", async () => {
    const token = await pendingToken(ids.users.client, "cleo@new-client.test");
    await signInAs(ids.users.client);
    const mine = await call(confirm.POST as Handler, post("/api/auth/email-change/confirm", { token }));
    expect(mine.body.data).toMatchObject({ ok: true, signedIn: true, redirectTo: "/portal/account#email" });
    // The person's session survives the change.
    expect(await verifySessionToken(jar.get(SESSION_COOKIE_NAME))).toMatchObject({ sub: ids.users.client });

    const other = await pendingToken(ids.users.owner);
    await signInAs(ids.users.editor1);
    const theirs = await call(confirm.POST as Handler, post("/api/auth/email-change/confirm", { token: other }));
    expect(theirs.body.data).toMatchObject({ ok: true, signedIn: true, redirectTo: "/my-jobs" });

    const staffToken = await pendingToken(ids.users.editor2, "ed.new@elsewhere.test");
    await signInAs(ids.users.editor2);
    const staff = await call(confirm.POST as Handler, post("/api/auth/email-change/confirm", { token: staffToken }));
    expect(staff.body.data).toMatchObject({ redirectTo: "/settings/account#email" });
  });

  it("a dead link → 400 with details.reason 'invalid_link'; a taken address → 'email_taken'", async () => {
    const token = await pendingToken(ids.users.owner);
    await call(confirm.POST as Handler, post("/api/auth/email-change/confirm", { token }));
    const used = await call(confirm.POST as Handler, post("/api/auth/email-change/confirm", { token }));
    expect(used.status).toBe(400);
    expect(used.body.error?.details).toMatchObject({ reason: "invalid_link" });

    const taken = await pendingToken(ids.users.editor1, "shared.address@elsewhere.test");
    await db.update(schema.users).set({ email: "shared.address@elsewhere.test" }).where(eq(schema.users.id, ids.users.editor2));
    const refused = await call(confirm.POST as Handler, post("/api/auth/email-change/confirm", { token: taken }));
    expect(refused.status).toBe(400);
    expect(refused.body.error?.details).toMatchObject({ reason: "email_taken" });
  });
});

describe("POST /api/auth/set-password and /api/auth/sign-out-others", () => {
  it("set-password: 422 when the account already has one; 200 for a Google-only account", async () => {
    await signInAs(ids.users.owner);
    const has = await call(setPasswordRoute.POST as Handler, post("/api/auth/set-password", { password: "A long new password" }));
    expect(has.status).toBe(422);

    await db.update(schema.users).set({ hasPassword: false }).where(eq(schema.users.id, ids.users.editor1));
    // SEC-03: a browser that signed in long ago (or whose cookie predates the sign-in time) must sign in again first.
    for (const minutesAgo of [60, null]) {
      await signInAs(ids.users.editor1, minutesAgo);
      const stale = await call(setPasswordRoute.POST as Handler, post("/api/auth/set-password", { password: "A long new password" }));
      expect(stale.status, String(minutesAgo)).toBe(403);
      expect(stale.body.error).toMatchObject({ code: "forbidden", details: { action: "account.recent_sign_in" } });
    }
    await signInAs(ids.users.editor1, 2);
    const ok = await call(setPasswordRoute.POST as Handler, post("/api/auth/set-password", { password: "A long new password" }));
    expect(ok).toEqual({ status: 200, body: { data: { ok: true } } });
  });

  it("SEC-03: 'Log out of other devices' re-issues this browser's cookie WITHOUT making its sign-in recent", async () => {
    await signInAs(ids.users.photographer1, 60);
    const before = await verifySessionToken(jar.get(SESSION_COOKIE_NAME));
    expect((await call(signOutOthers.POST as Handler, post("/api/auth/sign-out-others"))).status).toBe(200);
    const after = await verifySessionToken(jar.get(SESSION_COOKIE_NAME));
    expect(after?.sv).toBe((before?.sv ?? 0) + 1);
    expect(after?.at).toBe(before?.at);
    // A cookie without a sign-in time stays without one.
    await signInAs(ids.users.photographer2, null);
    expect((await call(signOutOthers.POST as Handler, post("/api/auth/sign-out-others"))).status).toBe(200);
    expect((await verifySessionToken(jar.get(SESSION_COOKIE_NAME)))?.at).toBeUndefined();
  });

  it("sign-out-others: this browser's cookie is replaced at the new version; the old cookie no longer works", async () => {
    const old = await signInAs(ids.users.photographer1);
    const { status, body } = await call(signOutOthers.POST as Handler, post("/api/auth/sign-out-others"));
    expect(status).toBe(200);
    expect(body.data).toEqual({ ok: true });
    const fresh = jar.get(SESSION_COOKIE_NAME);
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(old);
    expect((await verifySessionToken(fresh))?.sv).toBe((await verifySessionToken(old))!.sv + 1);

    // This browser keeps working …
    const again = await call(signOutOthers.POST as Handler, post("/api/auth/sign-out-others"));
    expect(again.status).toBe(200);
    // … while another one holding the first cookie is signed out.
    jar.set(SESSION_COOKIE_NAME, old);
    expect((await call(signOutOthers.POST as Handler, post("/api/auth/sign-out-others"))).status).toBe(401);
  });
});
