/**
 * POST /api/auth/signup hands back the "Confirm your email" result (`emailConfirmation`, docs/ACCOUNTS.md §3): outside
 * production without a mail provider it carries the dev-only `devLink` (the dev / e2e way through the flow); in
 * production it never does, and nothing is issued. Driven through the REAL route handler (CSRF, error mapping) with an
 * in-memory cookie jar standing in for `next/headers`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/db/test-db";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string) => {
      if (value) jar.set(name, value);
      else jar.delete(name);
    },
  }),
  headers: async () => new Headers(),
}));
// The route files share `_lib/route` (→ the Advanced-tools gate → src/server/page.ts, which is `server-only`).
vi.mock("server-only", () => ({}));

vi.resetModules();
const { and, eq } = await import("drizzle-orm");
const { setDbOverride } = await import("@/db/index");
const { authTokens, users } = await import("@/db/schema");
const { closeTestDbs, makeTestDb, seedMinimalOrg } = await import("@/db/test-db");
const signupRoute = await import("@/app/api/auth/signup/route");

const ORIGIN = "http://localhost:3130";
let db: TestDb;

beforeEach(async () => {
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("EMAIL_FROM", "");
  db = await makeTestDb();
  await seedMinimalOrg(db);
  setDbOverride(db);
  jar.clear();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  setDbOverride(null);
  await closeTestDbs();
});

interface SignUpBody {
  data?: { user: { id: string; email: string }; redirectTo: string; emailConfirmation?: { sent: boolean; reason: string | null; devLink?: string; expiresAt?: string } };
  error?: { code: string };
}

async function signUp(email: string): Promise<{ status: number; json: SignUpBody }> {
  const headers = new Headers({ origin: ORIGIN, "content-type": "application/json", "user-agent": "vitest" });
  const body = { ownerName: "Nia Newbie", email, password: "a-long-enough-password", studioName: "Nia Photo" };
  const res = await signupRoute.POST(new Request(`${ORIGIN}/api/auth/signup`, { method: "POST", headers, body: JSON.stringify(body) }), {
    params: Promise.resolve({}),
  });
  return { status: res.status, json: (await res.json()) as SignUpBody };
}

async function liveConfirmLinks(userId: string): Promise<number> {
  const rows = await db.select({ id: authTokens.id, usedAt: authTokens.usedAt }).from(authTokens).where(and(eq(authTokens.userId, userId), eq(authTokens.kind, "email_verify")));
  return rows.filter((r) => r.usedAt === null).length;
}

describe("POST /api/auth/signup → emailConfirmation", () => {
  it("development without a mail provider: a dev-only confirm link comes back (nothing emailed)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = await signUp("nia.dev@signup-route.test");
    expect(res.status).toBe(200);
    const confirmation = res.json.data?.emailConfirmation;
    expect(confirmation).toMatchObject({ sent: false, reason: "not_configured" });
    expect(confirmation?.devLink).toMatch(/^http:\/\/localhost:3130\/verify-email\?token=[A-Za-z0-9_-]{43}$/);
    expect(confirmation?.expiresAt).toEqual(expect.any(String));
    const user = res.json.data?.user;
    expect(user).toBeDefined();
    expect(await liveConfirmLinks(user?.id ?? "")).toBe(1);
    const [row] = await db.select({ emailVerifiedAt: users.emailVerifiedAt }).from(users).where(eq(users.id, user?.id ?? ""));
    expect(row?.emailVerifiedAt).toBeNull();
  });

  it("production without a mail provider: no link at all (nothing issued, nothing returned)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await signUp("nia.prod@signup-route.test");
    expect(res.status).toBe(200);
    expect(res.json.data?.emailConfirmation).toMatchObject({ sent: false, reason: "not_configured" });
    expect(res.json.data?.emailConfirmation?.devLink).toBeUndefined();
    expect(JSON.stringify(res.json)).not.toMatch(/verify-email\?token=/);
    expect(await liveConfirmLinks(res.json.data?.user.id ?? "")).toBe(0);
  });
});
