import { eq } from "drizzle-orm";
import { first } from "@/db/index";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityEvents, clients, users } from "@/db/schema";
import { contextFor, fakeClock, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import { buildContextFromDb } from "@/server/auth/session";
import { LOGIN_EMAIL_RATE_LIMIT, clearLoginRateLimits } from "@/server/auth/rate-limit";
import { clientIp } from "@/server/http";
import { verifyPassword } from "@/server/auth/password";
import { RateLimitedError, UnauthorizedError, ValidationError } from "@/server/errors";
import { withTx } from "./_shared";
import { authenticate, changePasswordInDb, preparePasswordChange, recordLogout } from "./auth";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  clearLoginRateLimits();
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

const events = async (type: string) =>
  db.select().from(activityEvents).where(eq(activityEvents.eventType, type)).orderBy(activityEvents.createdAt, activityEvents.rowid);

describe("authenticate", () => {
  it("accepts valid credentials (case-insensitive email), sets last_login_at and audits auth.logged_in", async () => {
    const user = await authenticate(db, { email: "  OWNER@studio.test ", password: ids.password, ip: "1.2.3.4", userAgent: "vitest" });
    expect(user).toMatchObject({ id: ids.users.owner, role: "photographer", sessionVersion: 1 });
    expect((await first(db.select().from(users).where(eq(users.id, ids.users.owner))))?.lastLoginAt).toBe("2026-10-08T00:00:00.000Z");
    const [event] = await events("auth.logged_in");
    expect(event).toMatchObject({ actorUserId: ids.users.owner, visibility: "management", newValue: { email: "owner@studio.test" } });
    expect(event.metadata).toMatchObject({ ip: "1.2.3.4", userAgent: "vitest", cause: "user" });
  });

  it("rejects a wrong password with a generic 401 and audits auth.login_failed without the password", async () => {
    await expect(authenticate(db, { email: ids.emails.editor1, password: "wrong-password" })).rejects.toThrow(UnauthorizedError);
    const [event] = await events("auth.login_failed");
    expect(event).toMatchObject({ actorUserId: null, entityId: ids.users.editor1, visibility: "management" });
    expect(JSON.stringify(event)).not.toContain("wrong-password");
  });

  it("rejects inactive users with the same message", async () => {
    const err = await authenticate(db, { email: ids.emails.inactiveEditor, password: ids.password }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as Error).message).toBe("Incorrect email or password");
    expect((await events("auth.login_failed"))[0].metadata).toMatchObject({ reason: "inactive" });
  });

  it("client users sign in while their portal is on; portal off or client archived → the same generic 401 (no oracle)", async () => {
    await expect(authenticate(db, { email: ids.emails.client, password: ids.password })).resolves.toMatchObject({ id: ids.users.client, role: "client" });

    await db.update(clients).set({ portalEnabled: false }).where(eq(clients.id, ids.clientId));
    const off = await authenticate(db, { email: ids.emails.client, password: ids.password }).catch((e: unknown) => e);
    expect(off).toBeInstanceOf(UnauthorizedError);
    expect((off as Error).message).toBe("Incorrect email or password");
    // identical to a wrong password
    const wrong = await authenticate(db, { email: ids.emails.client2, password: "wrong-password" }).catch((e: unknown) => e);
    expect((wrong as Error).message).toBe((off as Error).message);

    await db.update(clients).set({ archivedAt: "2026-10-07T00:00:00.000Z" }).where(eq(clients.id, ids.clientId2));
    const archived = await authenticate(db, { email: ids.emails.client2, password: ids.password }).catch((e: unknown) => e);
    expect(archived).toBeInstanceOf(UnauthorizedError);
    expect((archived as Error).message).toBe("Incorrect email or password");

    const failures = await events("auth.login_failed");
    expect(failures.map((e) => (e.metadata as { reason: string }).reason)).toEqual(["portal_closed", "bad_password", "portal_closed"]);
    expect(await events("auth.logged_in")).toHaveLength(1);
  });

  it("validates input", async () => {
    await expect(authenticate(db, { email: "not-an-email", password: "" })).rejects.toThrow(ValidationError);
  });

  it("rate-limits after 5 failures per email+IP, then a different IP still works", async () => {
    const attempt = (ip: string, password = "bad") => authenticate(db, { email: ids.emails.coAdmin, password, ip });
    for (let i = 0; i < 4; i += 1) await expect(attempt("9.9.9.9")).rejects.toThrow(UnauthorizedError);
    await expect(attempt("9.9.9.9")).rejects.toThrow(RateLimitedError);
    const blocked = await attempt("9.9.9.9", ids.password).catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(RateLimitedError);
    expect((blocked as RateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
    await expect(attempt("8.8.8.8", ids.password)).resolves.toMatchObject({ id: ids.users.coAdmin });
  });

  it("rotating X-Forwarded-For buys nothing: XFF is ignored without trusted proxies, so 5 failures → 429 (even for the right password)", async () => {
    const attempt = (i: number, password = "bad") =>
      authenticate(db, { email: ids.emails.editor1, password, ip: clientIp(new Headers({ "x-forwarded-for": `10.0.0.${i}` }), 0) });
    for (let i = 0; i < 4; i += 1) await expect(attempt(i)).rejects.toThrow(UnauthorizedError);
    await expect(attempt(4)).rejects.toThrow(RateLimitedError);
    for (let i = 5; i < 12; i += 1) await expect(attempt(i)).rejects.toThrow(RateLimitedError);
    await expect(attempt(12, ids.password)).rejects.toThrow(RateLimitedError);
  });

  it("the per-email limiter caps guesses across genuinely different IPs (trusted proxy)", async () => {
    // Behind a trusted proxy every attempt has its own real IP, so only the IP-independent limiter can stop it.
    const attempt = (i: number, password = "bad") =>
      authenticate(db, {
        email: ids.emails.editor1,
        password,
        ip: clientIp(new Headers({ "x-forwarded-for": `6.6.6.6, 203.0.113.${i}` }), 1),
      });
    for (let i = 0; i < LOGIN_EMAIL_RATE_LIMIT.attempts - 1; i += 1) await expect(attempt(i)).rejects.toThrow(UnauthorizedError);
    await expect(attempt(100)).rejects.toThrow(RateLimitedError);
    const blocked = await attempt(101, ids.password).catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(RateLimitedError);
    expect((blocked as RateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
    // other accounts are unaffected
    await expect(authenticate(db, { email: ids.emails.coAdmin, password: ids.password, ip: "203.0.113.200" })).resolves.toMatchObject({
      id: ids.users.coAdmin,
    });
  });
});

describe("change password / logout", () => {
  it("re-hashes, bumps session_version (old cookies die) and audits user.password_changed", async () => {
    const ctx = await contextFor(db, ids.users.editor1);
    const prepared = await preparePasswordChange(db, ctx, { current: ids.password, next: "a-much-better-passphrase" });
    const { sessionVersion } = await withTx((tx) => changePasswordInDb(tx, ctx, prepared), { db });
    expect(sessionVersion).toBe(2);
    const row = await first(db.select().from(users).where(eq(users.id, ids.users.editor1)));
    expect(await verifyPassword("a-much-better-passphrase", row?.passwordHash ?? "")).toBe(true);
    expect(row?.version).toBe(2);
    expect(await buildContextFromDb(db, ids.users.editor1, { sessionVersion: 1 })).toBeNull();
    const [event] = await events("user.password_changed");
    expect(event).toMatchObject({ visibility: "management", summary: "changed their password" });
    expect(JSON.stringify(event)).not.toMatch(/passphrase|\$2/);
  });

  it("rejects a wrong current password and a too-short new one", async () => {
    const ctx = await contextFor(db, ids.users.editor1);
    await expect(preparePasswordChange(db, ctx, { current: "nope", next: "a-much-better-passphrase" })).rejects.toThrow(/incorrect/);
    await expect(preparePasswordChange(db, ctx, { current: ids.password, next: "short" })).rejects.toThrow(ValidationError);
  });

  it("recordLogout audits auth.logged_out", async () => {
    const ctx = await contextFor(db, ids.users.coAdmin);
    await withTx((tx) => recordLogout(tx, ctx, { ip: "1.1.1.1" }), { db });
    expect(await events("auth.logged_out")).toHaveLength(1);
  });
});
