/** Postgres-backed rate limits (src/server/auth/db-rate-limit.ts): same semantics as the old in-memory limiters. */
import { createHash } from "node:crypto";
import { count } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { authRateLimits } from "@/db/schema";
import { makeTestDb, type TestDb } from "@/db/test-db";
import { LOGIN_EMAIL_RATE_LIMIT, LOGIN_RATE_LIMIT, RATE_LIMITS, SIGNUP_RATE_LIMIT } from "@/lib/constants";
import { RateLimitedError } from "@/server/errors";
import {
  DbRateLimiter,
  checkLoginAttempt,
  checkSignupAttempt,
  clearAllRateLimits,
  clearLoginLockout,
  emailIpKey,
  enforceRateLimit,
  ipKey,
  knownIpKey,
  limiters,
  pruneRateLimits,
  rateLimitKeyHash,
  recordLoginAttemptFailure,
  recordSignupAttempt,
  resetLoginAttempts,
  signupKey,
  userKey,
} from "./db-rate-limit";

const T0 = Date.parse("2026-10-09T00:00:00.000Z");
const EMAIL = "victim@studio.test";

let db: TestDb;
beforeEach(async () => {
  db = await makeTestDb();
});

async function rowCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(authRateLimits);
  return Number(row?.n ?? 0);
}

describe("login rate limits (email+IP and email-only)", () => {
  it("blocks one email+IP after LOGIN_RATE_LIMIT failures; another IP still has attempts", async () => {
    for (let i = 0; i < LOGIN_RATE_LIMIT.attempts - 1; i += 1) expect((await recordLoginAttemptFailure(db, EMAIL, "1.1.1.1", T0 + i)).allowed).toBe(true);
    expect((await recordLoginAttemptFailure(db, EMAIL, "1.1.1.1", T0 + 10)).allowed).toBe(false);
    expect((await checkLoginAttempt(db, EMAIL, "1.1.1.1", T0 + 11)).allowed).toBe(false);
    expect((await checkLoginAttempt(db, EMAIL, "2.2.2.2", T0 + 11)).allowed).toBe(true);
  });

  it("blocks the email after LOGIN_EMAIL_RATE_LIMIT failures however many IPs they came from", async () => {
    for (let i = 0; i < LOGIN_EMAIL_RATE_LIMIT.attempts - 1; i += 1) {
      expect((await recordLoginAttemptFailure(db, EMAIL, `10.0.${i}.1`, T0 + i)).allowed).toBe(true);
    }
    const last = await recordLoginAttemptFailure(db, EMAIL, "10.9.9.9", T0 + 100);
    expect(last.allowed).toBe(false);
    expect(last.retryAfterSeconds).toBeGreaterThan(0);
    expect((await checkLoginAttempt(db, EMAIL, "192.0.2.1", T0 + 200)).allowed).toBe(false);
    expect((await checkLoginAttempt(db, " Victim@Studio.test ", null, T0 + 200)).allowed).toBe(false);
    expect((await checkLoginAttempt(db, "someone-else@studio.test", "192.0.2.1", T0 + 200)).allowed).toBe(true);
    // the window drains with time
    expect((await checkLoginAttempt(db, EMAIL, "192.0.2.1", T0 + LOGIN_EMAIL_RATE_LIMIT.windowMinutes * 60_000 + 101)).allowed).toBe(true);
  });

  it("a successful login clears only the email+IP key, not the per-email window", async () => {
    for (let i = 0; i < LOGIN_EMAIL_RATE_LIMIT.attempts - 1; i += 1) await recordLoginAttemptFailure(db, EMAIL, `10.0.${i}.1`, T0 + i);
    await resetLoginAttempts(db, EMAIL, "10.0.0.1");
    expect((await recordLoginAttemptFailure(db, EMAIL, "10.0.0.1", T0 + 50)).allowed).toBe(false);
  });

  it("says how long to wait: until the oldest relevant failure leaves the window", async () => {
    const windowMs = LOGIN_RATE_LIMIT.windowMinutes * 60_000;
    for (let i = 0; i < LOGIN_RATE_LIMIT.attempts; i += 1) await recordLoginAttemptFailure(db, EMAIL, "1.1.1.1", T0 + i * 60_000);
    const denied = await checkLoginAttempt(db, EMAIL, "1.1.1.1", T0 + 5 * 60_000);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(Math.ceil((T0 + windowMs - (T0 + 5 * 60_000)) / 1000));
    expect((await checkLoginAttempt(db, EMAIL, "1.1.1.1", T0 + windowMs + 1)).allowed).toBe(true);
  });
});

describe("known browsers, per-IP cap and proving the address (SEC-06 / SEC-09 / UX-01)", () => {
  it("SEC-06: a browser that signed in before is never locked out by the per-email backstop strangers fill", async () => {
    // Strangers, 20 networks: the address is locked for every unknown browser…
    for (let i = 0; i < LOGIN_EMAIL_RATE_LIMIT.attempts; i += 1) await recordLoginAttemptFailure(db, EMAIL, `10.0.${i}.1`, T0 + i);
    expect((await checkLoginAttempt(db, EMAIL, "198.51.100.7", T0 + 100)).allowed).toBe(false);
    expect((await checkLoginAttempt(db, EMAIL, null, T0 + 100)).allowed).toBe(false);
    // …but the owner's own browser (its known-device id) still gets in, from the same network as anyone.
    expect((await checkLoginAttempt(db, EMAIL, "198.51.100.7", T0 + 100, { deviceId: "dev-owner-1" })).allowed).toBe(true);
    expect((await checkLoginAttempt(db, EMAIL, null, T0 + 100, { deviceId: "dev-owner-1" })).allowed).toBe(true);
  });

  it("a known browser still has its own limit of five (a stolen cookie buys nothing)", async () => {
    const scope = { deviceId: "dev-x" };
    for (let i = 0; i < RATE_LIMITS.loginDevice.attempts - 1; i += 1) expect((await recordLoginAttemptFailure(db, EMAIL, null, T0 + i, scope)).allowed).toBe(true);
    expect((await recordLoginAttemptFailure(db, EMAIL, null, T0 + 10, scope)).allowed).toBe(false);
    expect((await checkLoginAttempt(db, EMAIL, null, T0 + 11, scope)).allowed).toBe(false);
    // its failures are its own: another browser of the same person is untouched, and so is the per-email backstop
    expect((await checkLoginAttempt(db, EMAIL, null, T0 + 11, { deviceId: "dev-y" })).allowed).toBe(true);
    expect((await checkLoginAttempt(db, EMAIL, "1.2.3.4", T0 + 11)).allowed).toBe(true);
    // a success clears it
    await resetLoginAttempts(db, EMAIL, null, scope);
    expect((await checkLoginAttempt(db, EMAIL, null, T0 + 12, scope)).allowed).toBe(true);
  });

  it("SEC-09: one network is capped across every address (only when the IP is known)", async () => {
    for (let i = 0; i < RATE_LIMITS.loginIp.attempts; i += 1) await recordLoginAttemptFailure(db, `person${i}@studio.test`, "203.0.113.50", T0 + i);
    expect((await checkLoginAttempt(db, "fresh@studio.test", "203.0.113.50", T0 + 500)).allowed).toBe(false);
    expect((await checkLoginAttempt(db, "fresh@studio.test", "203.0.113.51", T0 + 500)).allowed).toBe(true);
    expect(knownIpKey(null)).toBeNull();
    expect(knownIpKey(" 203.0.113.50 ")).toBe("ip|203.0.113.50");
  });

  it("UX-01: proving the address (a reset) forgets the wrong passwords typed for it", async () => {
    for (let i = 0; i < LOGIN_EMAIL_RATE_LIMIT.attempts; i += 1) await recordLoginAttemptFailure(db, EMAIL, i < 5 ? "1.1.1.1" : `10.0.${i}.1`, T0 + i);
    expect((await checkLoginAttempt(db, EMAIL, "1.1.1.1", T0 + 100)).allowed).toBe(false);
    await clearLoginLockout(db, EMAIL, "1.1.1.1");
    expect((await checkLoginAttempt(db, EMAIL, "1.1.1.1", T0 + 101)).allowed).toBe(true);
  });
});

describe("storage", () => {
  it("never stores the raw email or IP: only a keyed hash (HMAC, session secret) of limiter:key", async () => {
    await recordLoginAttemptFailure(db, EMAIL, "203.0.113.9", T0);
    const rows = await db.select().from(authRateLimits);
    expect(rows).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toContain(EMAIL);
    expect(JSON.stringify(rows)).not.toContain("203.0.113.9");
    expect(rows.map((r) => r.keyHash).sort()).toEqual(
      [rateLimitKeyHash("login", emailIpKey(EMAIL, "203.0.113.9")), rateLimitKeyHash("loginEmail", EMAIL), rateLimitKeyHash("loginIp", "ip|203.0.113.9")].sort(),
    );
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.keyHash))).toBe(true);
    // DATA-07: a copy of the table cannot confirm a guessed address — the plain sha256 of the key is NOT what is stored.
    const plain = createHash("sha256").update(`loginEmail:${EMAIL}`, "utf8").digest("hex");
    expect(rows.map((r) => r.keyHash)).not.toContain(plain);
  });

  it("prunes rows past their window (and only those)", async () => {
    const quick = new DbRateLimiter("demoSignIn", { attempts: 3, windowMinutes: 1 }, { pruneProbability: 0 });
    await quick.hit(db, ipKey("1.1.1.1"), T0);
    await limiters.signup.hit(db, signupKey("1.1.1.1", EMAIL), T0);
    expect(await rowCount()).toBe(2);
    expect(await pruneRateLimits(db, T0 + 2 * 60_000)).toBe(1);
    expect(await rowCount()).toBe(1);
    // A limiter that prunes on every hit cleans up as it goes.
    const eager = new DbRateLimiter("demoSignIn", { attempts: 3, windowMinutes: 1 }, { pruneProbability: 1 });
    await eager.hit(db, ipKey("2.2.2.2"), T0);
    await eager.hit(db, ipKey("2.2.2.2"), T0 + 5 * 60_000);
    expect(await eager.hits(db, ipKey("2.2.2.2"), T0 + 5 * 60_000)).toEqual([new Date(T0 + 5 * 60_000).toISOString()]);
    await clearAllRateLimits(db);
    expect(await rowCount()).toBe(0);
  });
});

describe("every-attempt limiters", () => {
  it("sign-up: 5 per hour per IP, falling back to the email without an IP", async () => {
    for (let i = 0; i < SIGNUP_RATE_LIMIT.attempts; i += 1) await recordSignupAttempt(db, "198.51.100.7", `a${i}@x.test`, T0 + i);
    expect((await checkSignupAttempt(db, "198.51.100.7", "new@x.test", T0 + 10)).allowed).toBe(false);
    expect((await checkSignupAttempt(db, null, "new@x.test", T0 + 10)).allowed).toBe(true);
    expect(signupKey(null, " New@X.test ")).toBe("email|new@x.test");
  });

  it("enforceRateLimit records allowed attempts and throws RateLimitedError (429) beyond the policy", async () => {
    const key = userKey("u1");
    for (let i = 0; i < RATE_LIMITS.verifyResend.attempts; i += 1) {
      const res = await enforceRateLimit(db, "verifyResend", key, T0 + i);
      expect(res.remaining).toBe(RATE_LIMITS.verifyResend.attempts - i - 1);
    }
    const err = await enforceRateLimit(db, "verifyResend", key, T0 + 100).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).status).toBe(429);
    expect((err as RateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
    // Limiters and keys are independent.
    await expect(enforceRateLimit(db, "verifyResend", userKey("u2"), T0 + 100)).resolves.toMatchObject({ allowed: true });
    await expect(enforceRateLimit(db, "emailChange", key, T0 + 100)).resolves.toMatchObject({ allowed: true });
  });

  it("has a named limiter for every RATE_LIMITS policy", () => {
    for (const [name, policy] of Object.entries(RATE_LIMITS)) {
      expect(limiters[name as keyof typeof RATE_LIMITS].attempts, name).toBe(policy.attempts);
      expect(limiters[name as keyof typeof RATE_LIMITS].windowMs, name).toBe(policy.windowMinutes * 60_000);
    }
  });
});
