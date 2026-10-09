import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityEvents, users } from "@/db/schema";
import { contextFor, fakeClock, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import { buildContextFromDb } from "@/server/auth/session";
import { clearLoginRateLimits } from "@/server/auth/rate-limit";
import { verifyPassword } from "@/server/auth/password";
import { RateLimitedError, UnauthorizedError, ValidationError } from "@/server/errors";
import { withTx } from "./_shared";
import { authenticate, changePasswordInDb, preparePasswordChange, recordLogout } from "./auth";

let db: TestDb;
let ids: SeedIds;

beforeEach(() => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  clearLoginRateLimits();
  db = makeTestDb();
  ids = seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

const events = (type: string) => db.select().from(activityEvents).where(eq(activityEvents.eventType, type)).all();

describe("authenticate", () => {
  it("accepts valid credentials (case-insensitive email), sets last_login_at and audits auth.logged_in", async () => {
    const user = await authenticate(db, { email: "  OWNER@studio.test ", password: ids.password, ip: "1.2.3.4", userAgent: "vitest" });
    expect(user).toMatchObject({ id: ids.users.owner, role: "owner", sessionVersion: 1 });
    expect(db.select().from(users).where(eq(users.id, ids.users.owner)).get()?.lastLoginAt).toBe("2026-10-08T00:00:00.000Z");
    const [event] = events("auth.logged_in");
    expect(event).toMatchObject({ actorUserId: ids.users.owner, visibility: "management", newValue: { email: "owner@studio.test" } });
    expect(event.metadata).toMatchObject({ ip: "1.2.3.4", userAgent: "vitest", cause: "user" });
  });

  it("rejects a wrong password with a generic 401 and audits auth.login_failed without the password", async () => {
    await expect(authenticate(db, { email: ids.emails.editor1, password: "wrong-password" })).rejects.toThrow(UnauthorizedError);
    const [event] = events("auth.login_failed");
    expect(event).toMatchObject({ actorUserId: null, entityId: ids.users.editor1, visibility: "management" });
    expect(JSON.stringify(event)).not.toContain("wrong-password");
  });

  it("rejects inactive users with the same message", async () => {
    const err = await authenticate(db, { email: ids.emails.inactiveEditor, password: ids.password }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as Error).message).toBe("Incorrect email or password");
    expect(events("auth.login_failed")[0].metadata).toMatchObject({ reason: "inactive" });
  });

  it("validates input", async () => {
    await expect(authenticate(db, { email: "not-an-email", password: "" })).rejects.toThrow(ValidationError);
  });

  it("rate-limits after 5 failures per email+IP, then a different IP still works", async () => {
    const attempt = (ip: string, password = "bad") => authenticate(db, { email: ids.emails.manager, password, ip });
    for (let i = 0; i < 4; i += 1) await expect(attempt("9.9.9.9")).rejects.toThrow(UnauthorizedError);
    await expect(attempt("9.9.9.9")).rejects.toThrow(RateLimitedError);
    const blocked = await attempt("9.9.9.9", ids.password).catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(RateLimitedError);
    expect((blocked as RateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
    await expect(attempt("8.8.8.8", ids.password)).resolves.toMatchObject({ id: ids.users.manager });
  });
});

describe("change password / logout", () => {
  it("re-hashes, bumps session_version (old cookies die) and audits user.password_changed", async () => {
    const ctx = contextFor(db, ids.users.editor1);
    const prepared = await preparePasswordChange(db, ctx, { current: ids.password, next: "a-much-better-passphrase" });
    const { sessionVersion } = withTx((tx) => changePasswordInDb(tx, ctx, prepared), { db });
    expect(sessionVersion).toBe(2);
    const row = db.select().from(users).where(eq(users.id, ids.users.editor1)).get();
    expect(await verifyPassword("a-much-better-passphrase", row?.passwordHash ?? "")).toBe(true);
    expect(row?.version).toBe(2);
    expect(buildContextFromDb(db, ids.users.editor1, { sessionVersion: 1 })).toBeNull();
    const [event] = events("user.password_changed");
    expect(event).toMatchObject({ visibility: "management", summary: "changed their password" });
    expect(JSON.stringify(event)).not.toMatch(/passphrase|\$2/);
  });

  it("rejects a wrong current password and a too-short new one", async () => {
    const ctx = contextFor(db, ids.users.editor1);
    await expect(preparePasswordChange(db, ctx, { current: "nope", next: "a-much-better-passphrase" })).rejects.toThrow(/incorrect/);
    await expect(preparePasswordChange(db, ctx, { current: ids.password, next: "short" })).rejects.toThrow(ValidationError);
  });

  it("recordLogout audits auth.logged_out", () => {
    const ctx = contextFor(db, ids.users.manager);
    withTx((tx) => recordLogout(tx, ctx, { ip: "1.1.1.1" }), { db });
    expect(events("auth.logged_out")).toHaveLength(1);
  });
});
