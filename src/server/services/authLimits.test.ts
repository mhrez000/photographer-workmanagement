/**
 * Every front-door rate limit is wired to the Postgres-backed limiter (docs/ACCOUNTS.md §6) and answers in plain
 * words: driven through the REAL route handlers (CSRF, error mapping, `retry-after`) with an in-memory cookie jar
 * standing in for `next/headers`, and the services' fake clock moving time so each window really drains.
 *
 *   login           5 failures / 15 min per email + IP (+ the per-email backstop)   "Too many sign-in attempts."
 *   signup          5 / hour per IP (honeypot hits count too)                          "Too many new studios …"
 *   forgot password 5 / 15 min per email + IP                                           "Too many reset emails …"
 *   reset submit    10 dead links / 15 min per known client IP                          "Too many tries with reset links …"
 *   password check  10 wrong current passwords / 15 min per person                      "Too many wrong passwords."
 *   demo sign-in    30 / 10 min per IP                                                  "Too many demo sign-ins …"
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SeedIds, TestDb } from "@/db/test-db";
import { RATE_LIMITS, SESSION_COOKIE_NAME } from "@/lib/constants";

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
const { count, eq } = await import("drizzle-orm");
const { setDbOverride } = await import("@/db/index");
const { authRateLimits, authTokens } = await import("@/db/schema");
const { closeTestDbs, fakeClock, makeTestDb, seedMinimalOrg } = await import("@/db/test-db");
const { signSessionToken } = await import("@/server/auth/session");
const { RateLimitedError } = await import("@/server/errors");
const { issueToken } = await import("@/server/auth/tokens");
const { rateLimitMessage, waitInWords, RESET_LINK_LIMIT } = await import("./authLimits");
const { preparePasswordChange } = await import("./auth");
const { withTx } = await import("./_shared");
const { contextFor } = await import("@/db/test-db");
const loginRoute = await import("@/app/api/auth/login/route");
const signupRoute = await import("@/app/api/auth/signup/route");
const forgotRoute = await import("@/app/api/auth/forgot-password/route");
const resetRoute = await import("@/app/api/auth/reset-password/route");
const demoRoute = await import("@/app/api/auth/demo/route");
const changePasswordRoute = await import("@/app/api/auth/change-password/route");

const ORIGIN = "http://localhost:3130";
let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  // Client IPs are only trusted behind a known proxy (src/server/http.ts `clientIp`).
  vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
  setDbOverride(db);
  jar.clear();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  setDbOverride(null);
  fakeClock.reset();
  await closeTestDbs();
});

type Handler = (req: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function post(handler: Handler, path: string, body: unknown, ip?: string): Promise<{ status: number; retryAfter: string | null; json: { data?: Record<string, unknown>; error?: { code: string; message: string; details?: { retryAfterSeconds?: number } } } }> {
  const headers = new Headers({ origin: ORIGIN, "content-type": "application/json", "user-agent": "vitest" });
  if (ip) headers.set("x-forwarded-for", ip);
  const res = await handler(new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) }), { params: Promise.resolve({}) });
  return { status: res.status, retryAfter: res.headers.get("retry-after"), json: (await res.json()) as never };
}

const PLAIN_429 = (lead: string) => new RegExp(`^${lead.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} Try again in (a minute|\\d+ minutes)\\.$`);

function expectPlain429(res: Awaited<ReturnType<typeof post>>, lead: string, windowMinutes: number) {
  expect(res.status).toBe(429);
  expect(res.json.error?.code).toBe("rate_limited");
  expect(res.json.error?.message).toMatch(PLAIN_429(lead));
  const seconds = Number(res.retryAfter);
  expect(seconds).toBeGreaterThan(0);
  expect(seconds).toBeLessThanOrEqual(windowMinutes * 60);
  expect(res.json.error?.details?.retryAfterSeconds).toBe(seconds);
  // The minutes in the copy match the header.
  expect(res.json.error?.message).toContain(waitInWords(seconds));
}

const rowsOf = async (limiter: string) => Number((await db.select({ n: count() }).from(authRateLimits).where(eq(authRateLimits.limiter, limiter)))[0]?.n ?? 0);

describe("plain copy", () => {
  it("says how many minutes to wait, never less than a minute", () => {
    expect(waitInWords(1)).toBe("a minute");
    expect(waitInWords(60)).toBe("a minute");
    expect(waitInWords(61)).toBe("2 minutes");
    expect(waitInWords(14 * 60 + 1)).toBe("15 minutes");
    expect(rateLimitMessage("sign_in", 600)).toBe("Too many sign-in attempts. Try again in 10 minutes.");
    expect(rateLimitMessage("demo", 30)).toBe("Too many demo sign-ins from this network. Try again in a minute.");
  });
});

describe("login (POST /api/auth/login)", () => {
  it("5 failures per email + IP → 429 with retry-after and plain minutes, even for the right password; another IP still works; the window drains", async () => {
    const wrong = { email: ids.emails.editor1, password: "not-the-password" };
    for (let i = 0; i < RATE_LIMITS.login.attempts - 1; i += 1) expect((await post(loginRoute.POST, "/api/auth/login", wrong, "9.9.9.9")).status).toBe(401);
    expectPlain429(await post(loginRoute.POST, "/api/auth/login", wrong, "9.9.9.9"), "Too many sign-in attempts.", 15);
    const right = { email: ids.emails.editor1, password: ids.password };
    expectPlain429(await post(loginRoute.POST, "/api/auth/login", right, "9.9.9.9"), "Too many sign-in attempts.", 15);
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);

    // Another network is unaffected.
    const elsewhere = await post(loginRoute.POST, "/api/auth/login", right, "8.8.8.8");
    expect(elsewhere.status).toBe(200);
    expect(elsewhere.json.data?.redirectTo).toBe("/my-jobs");
    jar.clear();

    // 15 minutes later the first network may try again.
    fakeClock.advanceMinutes(RATE_LIMITS.login.windowMinutes + 1);
    expect((await post(loginRoute.POST, "/api/auth/login", right, "9.9.9.9")).status).toBe(200);
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(true);
  });

  it("the per-email backstop holds across many networks; only failures count (successes are free)", async () => {
    for (let i = 0; i < 5; i += 1) expect((await post(loginRoute.POST, "/api/auth/login", { email: ids.emails.owner, password: ids.password }, "7.7.7.7")).status).toBe(200);
    expect(await rowsOf("login")).toBe(0);
    expect(await rowsOf("loginEmail")).toBe(0);
    for (let i = 0; i < RATE_LIMITS.loginEmail.attempts - 1; i += 1) {
      expect((await post(loginRoute.POST, "/api/auth/login", { email: ids.emails.editor2, password: "wrong-wrong" }, `203.0.113.${i}`)).status).toBe(401);
    }
    expectPlain429(await post(loginRoute.POST, "/api/auth/login", { email: ids.emails.editor2, password: "wrong-wrong" }, "198.51.100.1"), "Too many sign-in attempts.", 15);
    expectPlain429(await post(loginRoute.POST, "/api/auth/login", { email: ids.emails.editor2, password: ids.password }, "198.51.100.2"), "Too many sign-in attempts.", 15);
    expect(await rowsOf("loginEmail")).toBe(RATE_LIMITS.loginEmail.attempts);
  });
});

describe("sign-up (POST /api/auth/signup)", () => {
  const GOOD = { ownerName: "Mo Carter", password: "CorrectHorse9!", studioName: "Limit Studio" };

  it("5 per hour per network (taken emails and honeypot hits count too) → 429; another network still works; the hour drains", async () => {
    expect((await post(signupRoute.POST, "/api/auth/signup", { ...GOOD, email: "a@limits.test" }, "5.5.5.5")).status).toBe(200);
    jar.clear();
    expect((await post(signupRoute.POST, "/api/auth/signup", { ...GOOD, email: ids.emails.owner }, "5.5.5.5")).status).toBe(400);
    expect((await post(signupRoute.POST, "/api/auth/signup", { ...GOOD, email: "bot@limits.test", website: "https://spam.example" }, "5.5.5.5")).status).toBe(400);
    expect((await post(signupRoute.POST, "/api/auth/signup", { ...GOOD, email: "b@limits.test" }, "5.5.5.5")).status).toBe(200);
    jar.clear();
    expect((await post(signupRoute.POST, "/api/auth/signup", { ...GOOD, email: "c@limits.test" }, "5.5.5.5")).status).toBe(200);
    jar.clear();
    expectPlain429(await post(signupRoute.POST, "/api/auth/signup", { ...GOOD, email: "d@limits.test" }, "5.5.5.5"), "Too many new studios from this network.", 60);
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);

    expect((await post(signupRoute.POST, "/api/auth/signup", { ...GOOD, email: "e@limits.test" }, "6.6.6.6")).status).toBe(200);
    jar.clear();
    fakeClock.advanceMinutes(61);
    expect((await post(signupRoute.POST, "/api/auth/signup", { ...GOOD, email: "d@limits.test" }, "5.5.5.5")).status).toBe(200);
  });

  it("a form whose email is unusable does not use up an attempt; one that would look its address up does (SEC-04)", async () => {
    for (let i = 0; i < 8; i += 1) expect((await post(signupRoute.POST, "/api/auth/signup", { ...GOOD, email: "not-an-email", password: "short" }, "4.4.4.4")).status).toBe(400);
    expect(await rowsOf("signup")).toBe(0);
    // A usable address with other mistakes: the "is it taken?" answer only comes inside the limit.
    for (let i = 0; i < RATE_LIMITS.signup.attempts; i += 1) {
      expect((await post(signupRoute.POST, "/api/auth/signup", { ...GOOD, email: `probe${i}@limits.test`, password: "short" }, "4.4.4.4")).status).toBe(400);
    }
    expect(await rowsOf("signup")).toBe(RATE_LIMITS.signup.attempts);
    expectPlain429(await post(signupRoute.POST, "/api/auth/signup", { ...GOOD, email: ids.emails.owner, password: "short" }, "4.4.4.4"), "Too many new studios from this network.", 60);
  });
});

describe("forgot password (POST /api/auth/forgot-password)", () => {
  it("5 per 15 min per email + network → 429 in plain words; another email still answers ok; the window drains", async () => {
    for (let i = 0; i < RATE_LIMITS.passwordReset.attempts; i += 1) {
      const ok = await post(forgotRoute.POST, "/api/auth/forgot-password", { email: ids.emails.editor1 }, "3.3.3.3");
      expect(ok.status).toBe(200);
      expect(ok.json.data).toMatchObject({ ok: true });
    }
    expectPlain429(await post(forgotRoute.POST, "/api/auth/forgot-password", { email: ids.emails.editor1 }, "3.3.3.3"), "Too many reset emails asked for.", 15);
    expect((await post(forgotRoute.POST, "/api/auth/forgot-password", { email: ids.emails.editor2 }, "3.3.3.3")).status).toBe(200);
    fakeClock.advanceMinutes(16);
    expect((await post(forgotRoute.POST, "/api/auth/forgot-password", { email: ids.emails.editor1 }, "3.3.3.3")).status).toBe(200);
  });
});

describe("reset submit (POST /api/auth/reset-password)", () => {
  const deadLink = (i: number) => `dead-link-${String(i).padStart(4, "0")}-abcdefghijklmnopqrstuvwxyz0123`;

  it(`${RESET_LINK_LIMIT.attempts} dead links per network → 429 (before any hashing); a live link from another network still works`, async () => {
    for (let i = 0; i < RESET_LINK_LIMIT.attempts; i += 1) {
      const res = await post(resetRoute.POST, "/api/auth/reset-password", { token: deadLink(i), password: "BrandNewPass42!" }, "2.2.2.2");
      expect(res.status).toBe(400);
      expect(res.json.error?.message).toBe("This reset link is no longer valid");
    }
    expectPlain429(await post(resetRoute.POST, "/api/auth/reset-password", { token: deadLink(99), password: "BrandNewPass42!" }, "2.2.2.2"), "Too many tries with reset links that no longer work.", 15);

    const issued = await withTx((tx) => issueToken(tx, { organisationId: ids.organisationId, userId: ids.users.editor1, kind: "password_reset", createdByUserId: null, now: fakeClock.now() }), { db });
    // The blocked network is blocked even for a live link…
    expect((await post(resetRoute.POST, "/api/auth/reset-password", { token: issued.token, password: "BrandNewPass42!" }, "2.2.2.2")).status).toBe(429);
    // …another one is not, and a success is never counted.
    const ok = await post(resetRoute.POST, "/api/auth/reset-password", { token: issued.token, password: "BrandNewPass42!" }, "1.1.1.1");
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ ok: true, redirectTo: "/my-jobs" });
    const tokenRows = await db.select().from(authTokens).where(eq(authTokens.userId, ids.users.editor1));
    expect(tokenRows[0]?.usedAt).not.toBeNull();

    fakeClock.advanceMinutes(RESET_LINK_LIMIT.windowMinutes + 1);
    expect((await post(resetRoute.POST, "/api/auth/reset-password", { token: deadLink(100), password: "BrandNewPass42!" }, "2.2.2.2")).status).toBe(400);
  });

  it("without a known client IP nothing is counted (a shared 'unknown' bucket would let one person block every reset)", async () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "0");
    for (let i = 0; i < RESET_LINK_LIMIT.attempts + 3; i += 1) {
      expect((await post(resetRoute.POST, "/api/auth/reset-password", { token: deadLink(i), password: "BrandNewPass42!" }, "2.2.2.2")).status).toBe(400);
    }
    expect(await rowsOf("passwordReset")).toBe(0);
  });
});

describe("wrong current password (passwordCheck)", () => {
  it("10 wrong current passwords per person → 429 through POST /api/auth/change-password; the right one still needs the window to drain", async () => {
    jar.set(SESSION_COOKIE_NAME, await signSessionToken({ sub: ids.users.editor1, sv: 1, k: "staff", r: "editor" }));
    const wrong = { current: "not-my-password", next: "AnotherGoodPass12!" };
    for (let i = 0; i < RATE_LIMITS.passwordCheck.attempts - 1; i += 1) {
      const res = await post(changePasswordRoute.POST as Handler, "/api/auth/change-password", wrong);
      expect(res.status).toBe(400);
      expect(res.json.error?.message).toBe("That password isn’t right");
    }
    expectPlain429(await post(changePasswordRoute.POST as Handler, "/api/auth/change-password", wrong), "Too many wrong passwords.", 15);
    expectPlain429(await post(changePasswordRoute.POST as Handler, "/api/auth/change-password", { current: ids.password, next: "AnotherGoodPass12!" }), "Too many wrong passwords.", 15);

    // Per person: someone else is unaffected.
    const other = await contextFor(db, ids.users.editor2);
    await expect(preparePasswordChange(db, other, { current: ids.password, next: "AnotherGoodPass12!" })).resolves.toMatchObject({ userId: ids.users.editor2 });

    fakeClock.advanceMinutes(16);
    const ok = await post(changePasswordRoute.POST as Handler, "/api/auth/change-password", { current: ids.password, next: "AnotherGoodPass12!" });
    expect(ok.status).toBe(200);
  });

  it("a right current password never counts", async () => {
    const ctx = await contextFor(db, ids.users.editor1);
    for (let i = 0; i < 12; i += 1) await preparePasswordChange(db, ctx, { current: ids.password, next: "AnotherGoodPass12!" });
    expect(await rowsOf("passwordCheck")).toBe(0);
    const err = await preparePasswordChange(db, ctx, { current: "nope", next: "AnotherGoodPass12!" }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RateLimitedError);
    expect(await rowsOf("passwordCheck")).toBe(1);
  });
});

describe("demo sign-in (POST /api/auth/demo)", () => {
  it("30 per 10 minutes per network → 429 in plain words; another network still gets in; the window drains", async () => {
    await closeTestDbs();
    db = await makeTestDb();
    ids = await seedMinimalOrg(db, { isDemo: true });
    setDbOverride(db);
    for (let i = 0; i < RATE_LIMITS.demoSignIn.attempts; i += 1) {
      const res = await post(demoRoute.POST, "/api/auth/demo", { persona: "editor" }, "4.3.2.1");
      expect(res.status, `attempt ${i + 1}`).toBe(200);
    }
    jar.clear();
    expectPlain429(await post(demoRoute.POST, "/api/auth/demo", { persona: "owner" }, "4.3.2.1"), "Too many demo sign-ins from this network.", 10);
    expect(jar.has(SESSION_COOKIE_NAME)).toBe(false);
    expect((await post(demoRoute.POST, "/api/auth/demo", { persona: "owner" }, "4.3.2.2")).status).toBe(200);
    fakeClock.advanceMinutes(11);
    expect((await post(demoRoute.POST, "/api/auth/demo", { persona: "owner" }, "4.3.2.1")).status).toBe(200);
  });
});
