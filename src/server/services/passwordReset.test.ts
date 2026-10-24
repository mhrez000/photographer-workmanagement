/**
 * Self-service password reset (front door): the request always answers ok (no account oracle), a token only for an
 * active + accepted user (one live token per user), 60-minute expiry, single use, session_version bump (other
 * sessions die), the audit rows and the per email+IP rate limit.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first } from "@/db/index";
import { activityEvents, authTokens, users } from "@/db/schema";
import { contextFor, fakeClock, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import { PASSWORD_RESET_RATE_LIMIT, RESET_TTL_MINUTES } from "@/lib/constants";
import { verifyPassword } from "@/server/auth/password";
import { buildContextFromDb } from "@/server/auth/session";
import { hashToken } from "@/server/auth/tokens";
import { RateLimitedError, UnauthorizedError, ValidationError } from "@/server/errors";
import { withTx } from "./_shared";
import { authenticate } from "./auth";
import { RESET_INVALID_MESSAGE, requestPasswordReset, resetPassword } from "./passwordReset";
import { inviteUser } from "./users";

let db: TestDb;
let ids: SeedIds;

const NEW_PASSWORD = "ResetMePlease77!";

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

const userRow = async (id: string) => first(db.select().from(users).where(eq(users.id, id)));
const tokensOf = async (userId: string) => db.select().from(authTokens).where(eq(authTokens.userId, userId)).orderBy(authTokens.createdAt);
const allTokens = async () => db.select().from(authTokens);
const eventsOf = async (type: string) => db.select().from(activityEvents).where(eq(activityEvents.eventType, type)).orderBy(activityEvents.createdAt, activityEvents.rowid);

/** Requests a reset and returns the plain token (from the dev-only resetUrl; email is not configured in tests). */
async function requestToken(email: string, ip: string | null = "3.3.3.3"): Promise<string> {
  const res = await requestPasswordReset(db, { email, ip, userAgent: "vitest" }, { requestId: "req-forgot" });
  expect(res.ok).toBe(true);
  expect(res.emailed).toBe(false);
  if (!res.resetUrl) throw new Error("expected a dev resetUrl (NODE_ENV !== production, email not configured)");
  const token = new URL(res.resetUrl).searchParams.get("token");
  if (!token) throw new Error("resetUrl has no token");
  return token;
}
const invalid = async (p: Promise<unknown>) => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as Error).message).toBe(RESET_INVALID_MESSAGE);
  expect((err as ValidationError).status).toBe(400);
};

describe("requestPasswordReset", () => {
  it("unknown email → ok, no token, no event (the answer is identical to a known one)", async () => {
    const res = await requestPasswordReset(db, { email: "nobody@studio.test", ip: "3.3.3.3" });
    expect(res).toEqual({ ok: true, emailed: false });
    expect(await allTokens()).toHaveLength(0);
    expect(await eventsOf("auth.password_reset_requested")).toHaveLength(0);
  });

  it("inactive and not-yet-accepted (pending invite) users get ok but no token", async () => {
    const ownerCtx = await contextFor(db, ids.users.owner);
    const pending = await withTx((tx) => inviteUser(tx, ownerCtx, { email: "pending@studio.test", name: "Pen Ding", role: "editor" }), { db });
    for (const email of [ids.emails.inactiveEditor, "pending@studio.test"]) {
      await expect(requestPasswordReset(db, { email, ip: "3.3.3.3" })).resolves.toEqual({ ok: true, emailed: false });
    }
    expect((await allTokens()).filter((t) => t.kind === "password_reset")).toHaveLength(0);
    expect(await tokensOf(pending.user.id)).toHaveLength(1); // only the invite token
    expect(await eventsOf("auth.password_reset_requested")).toHaveLength(0);
  });

  it("an active, accepted user gets a hashed 60-minute token, an audited management event (actor null) and, in dev without email, the link", async () => {
    const token = await requestToken(" Editor01@Studio.test ");
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const rows = await tokensOf(ids.users.editor1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organisationId: ids.organisationId,
      kind: "password_reset",
      createdByUserId: null,
      usedAt: null,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.parse("2026-10-08T00:00:00.000Z") + RESET_TTL_MINUTES * 60_000).toISOString(),
    });
    expect(JSON.stringify(rows)).not.toContain(token);

    const [event] = await eventsOf("auth.password_reset_requested");
    expect(event).toMatchObject({ entityType: "auth", entityId: ids.users.editor1, organisationId: ids.organisationId, actorUserId: null, visibility: "management", action: "requested", newValue: { email: ids.emails.editor1, expiresAt: rows[0].expiresAt } });
    expect(event.metadata).toMatchObject({ requestId: "req-forgot", ip: "3.3.3.3", userAgent: "vitest", superseded: 0, emailed: false, targetUserId: ids.users.editor1 });
    expect(JSON.stringify(event)).not.toContain(token);
  });

  it("one live token per user: a second request supersedes the first (metadata.superseded = 1)", async () => {
    const first1 = await requestToken(ids.emails.editor1);
    fakeClock.advanceMinutes(5);
    const second = await requestToken(ids.emails.editor1);
    expect(second).not.toBe(first1);
    const rows = await tokensOf(ids.users.editor1);
    expect(rows).toHaveLength(2);
    expect(rows[0].usedAt).toBe(fakeClock.now());
    expect(rows[1].usedAt).toBeNull();
    expect((await eventsOf("auth.password_reset_requested"))[1].metadata).toMatchObject({ superseded: 1 });

    await invalid(resetPassword(db, { token: first1, password: NEW_PASSWORD }));
    await expect(resetPassword(db, { token: second, password: NEW_PASSWORD })).resolves.toMatchObject({ userId: ids.users.editor1 });
  });

  it(`rate limit: ${PASSWORD_RESET_RATE_LIMIT.attempts} requests per email + IP then 429; another IP or email is unaffected; also keyed without an IP`, async () => {
    for (let i = 0; i < PASSWORD_RESET_RATE_LIMIT.attempts; i += 1) {
      await expect(requestPasswordReset(db, { email: "nobody@studio.test", ip: "4.4.4.4" })).resolves.toEqual({ ok: true, emailed: false });
    }
    const err = await requestPasswordReset(db, { email: "nobody@studio.test", ip: "4.4.4.4" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
    await expect(requestPasswordReset(db, { email: "nobody@studio.test", ip: "4.4.4.5" })).resolves.toEqual({ ok: true, emailed: false });
    await expect(requestPasswordReset(db, { email: "someone@studio.test", ip: "4.4.4.4" })).resolves.toEqual({ ok: true, emailed: false });

    for (let i = 0; i < PASSWORD_RESET_RATE_LIMIT.attempts; i += 1) await requestPasswordReset(db, { email: "noip@studio.test", ip: null });
    await expect(requestPasswordReset(db, { email: "noip@studio.test", ip: null })).rejects.toThrow(RateLimitedError);
  });

  it("validates the input (400) without touching the limiter's semantics for valid ones", async () => {
    await expect(requestPasswordReset(db, { email: "not-an-email" })).rejects.toThrow(ValidationError);
    await expect(requestPasswordReset(db, { email: ids.emails.owner, extra: 1 })).rejects.toThrow(ValidationError);
    await expect(requestPasswordReset(db, null)).rejects.toThrow(ValidationError);
    expect(await allTokens()).toHaveLength(0);
  });
});

describe("resetPassword", () => {
  it("sets the new password, bumps session_version (every other session dies), marks the token used and audits user.password_changed with cause 'reset'", async () => {
    const token = await requestToken(ids.emails.editor1);
    const before = await userRow(ids.users.editor1);
    const stale = await buildContextFromDb(db, ids.users.editor1, { sessionVersion: before?.sessionVersion });
    expect(stale).not.toBeNull();

    fakeClock.advanceMinutes(10);
    const result = await resetPassword(db, { token, password: NEW_PASSWORD, ip: "3.3.3.3", userAgent: "vitest" }, { requestId: "req-reset" });
    expect(result).toEqual({ userId: ids.users.editor1, organisationId: ids.organisationId, email: ids.emails.editor1, role: "editor", sessionVersion: (before?.sessionVersion ?? 1) + 1 });

    const after = await userRow(ids.users.editor1);
    expect(after).toMatchObject({ sessionVersion: (before?.sessionVersion ?? 1) + 1, version: (before?.version ?? 1) + 1, updatedAt: fakeClock.now() });
    expect(await verifyPassword(NEW_PASSWORD, after?.passwordHash ?? "")).toBe(true);
    expect(await verifyPassword(ids.password, after?.passwordHash ?? "")).toBe(false);
    expect((await tokensOf(ids.users.editor1))[0].usedAt).toBe(fakeClock.now());

    // the old cookie's session version no longer matches → signed out everywhere else
    expect(await buildContextFromDb(db, ids.users.editor1, { sessionVersion: before?.sessionVersion })).toBeNull();
    expect(await buildContextFromDb(db, ids.users.editor1, { sessionVersion: result.sessionVersion })).not.toBeNull();

    const [event] = await eventsOf("user.password_changed");
    expect(event).toMatchObject({ entityId: ids.users.editor1, actorUserId: ids.users.editor1, visibility: "management", action: "updated", previousValue: { sessionVersion: before?.sessionVersion }, newValue: { sessionVersion: result.sessionVersion } });
    expect(event.metadata).toMatchObject({ cause: "reset", reset: true, self: true, via: "reset_link", requestId: "req-reset", ip: "3.3.3.3" });
    expect(JSON.stringify(event)).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(event)).not.toContain(token);

    await expect(authenticate(db, { email: ids.emails.editor1, password: NEW_PASSWORD })).resolves.toMatchObject({ id: ids.users.editor1 });
    await expect(authenticate(db, { email: ids.emails.editor1, password: ids.password })).rejects.toThrow(UnauthorizedError);
  });

  it("single use: the same link cannot reset twice", async () => {
    const token = await requestToken(ids.emails.owner);
    await resetPassword(db, { token, password: NEW_PASSWORD });
    await invalid(resetPassword(db, { token, password: "YetAnotherPass9!" }));
    expect(await verifyPassword(NEW_PASSWORD, (await userRow(ids.users.owner))?.passwordHash ?? "")).toBe(true);
    expect(await eventsOf("user.password_changed")).toHaveLength(1);
  });

  it("expiry: the link dies after RESET_TTL_MINUTES; unknown / malformed tokens fail with the same generic 400", async () => {
    const token = await requestToken(ids.emails.owner);
    fakeClock.advanceMinutes(RESET_TTL_MINUTES);
    fakeClock.advanceMs(1);
    await invalid(resetPassword(db, { token, password: NEW_PASSWORD }));
    expect((await userRow(ids.users.owner))?.sessionVersion).toBe(1);
    await invalid(resetPassword(db, { token: "unknown-token-that-is-long-enough-0123456789", password: NEW_PASSWORD }));
    await expect(resetPassword(db, { token: "short", password: NEW_PASSWORD })).rejects.toThrow(ValidationError);
    await expect(resetPassword(db, { token, password: "weak" })).rejects.toThrow(ValidationError);
  });

  it("an account deactivated after the request can no longer use its link; an invite token is not a reset token", async () => {
    const token = await requestToken(ids.emails.editor2);
    await db.update(users).set({ isActive: false, deactivatedAt: fakeClock.now() }).where(eq(users.id, ids.users.editor2));
    await invalid(resetPassword(db, { token, password: NEW_PASSWORD }));

    const ownerCtx = await contextFor(db, ids.users.owner);
    const pending = await withTx((tx) => inviteUser(tx, ownerCtx, { email: "pending@studio.test", name: "Pen Ding", role: "editor" }), { db });
    await invalid(resetPassword(db, { token: pending.invite?.token ?? "", password: NEW_PASSWORD }));
    expect((await userRow(pending.user.id))?.acceptedAt).toBeNull();
  });

  it("UX-01: after five wrong passwords, a successful reset lets the NEW password in straight away (no 'Too many sign-in attempts')", async () => {
    for (let i = 0; i < 5; i += 1) await authenticate(db, { email: ids.emails.editor1, password: `wrong-${i}`, ip: "7.7.7.7" }).catch(() => undefined);
    const locked = await authenticate(db, { email: ids.emails.editor1, password: ids.password, ip: "7.7.7.7" }).catch((e: unknown) => e);
    expect(locked).toBeInstanceOf(RateLimitedError);
    const token = await requestToken(ids.emails.editor1, "7.7.7.7");
    await resetPassword(db, { token, password: NEW_PASSWORD, ip: "7.7.7.7" });
    await expect(authenticate(db, { email: ids.emails.editor1, password: NEW_PASSWORD, ip: "7.7.7.7" })).resolves.toMatchObject({ id: ids.users.editor1 });
  });

  it("UX-01: the per-email backstop strangers filled from many networks is forgotten too", async () => {
    for (let i = 0; i < 20; i += 1) await authenticate(db, { email: ids.emails.editor1, password: "guess", ip: `10.1.${i}.1` }).catch(() => undefined);
    expect(await authenticate(db, { email: ids.emails.editor1, password: ids.password, ip: "7.7.7.8" }).catch((e: unknown) => e)).toBeInstanceOf(RateLimitedError);
    const token = await requestToken(ids.emails.editor1, "7.7.7.8");
    await resetPassword(db, { token, password: NEW_PASSWORD, ip: "7.7.7.8" });
    await expect(authenticate(db, { email: ids.emails.editor1, password: NEW_PASSWORD, ip: "7.7.7.8" })).resolves.toMatchObject({ id: ids.users.editor1 });
  });

  it("SEC-08: a reset link sent to the OLD address dies when the email changes (admin edit), and never confirms the new address", async () => {
    const token = await requestToken(ids.emails.editor1);
    const ownerCtx = await contextFor(db, ids.users.owner);
    const { updateUser } = await import("./users");
    const before = await userRow(ids.users.editor1);
    await withTx((tx) => updateUser(tx, ownerCtx, { userId: ids.users.editor1, email: "editor1.new@studio.test", expectedVersion: before?.version }), { db });
    await invalid(resetPassword(db, { token, password: NEW_PASSWORD }));
    const after = await userRow(ids.users.editor1);
    expect(after).toMatchObject({ email: "editor1.new@studio.test", emailVerifiedAt: null });
    expect(await verifyPassword(ids.password, after?.passwordHash ?? "")).toBe(true);
  });

  it("client users reset through the same flow", async () => {
    const token = await requestToken(ids.emails.client);
    await expect(resetPassword(db, { token, password: NEW_PASSWORD })).resolves.toMatchObject({ role: "client", userId: ids.users.client });
    await expect(authenticate(db, { email: ids.emails.client, password: NEW_PASSWORD })).resolves.toMatchObject({ id: ids.users.client, role: "client" });
  });
});
