/**
 * Demo studio hardening (docs/ACCOUNTS.md §7): inside an `is_demo` studio the services refuse what would spoil it for
 * the next visitor — a 403 `demo.<what>` with the plain copy of DEMO_BLOCKED_MESSAGES, nothing written, nothing
 * audited — while ordinary work (renaming someone, managing non-persona people) still goes through, and a real
 * studio next to the demo one is untouched (org isolation).
 */
import { and, count, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first, type Tx } from "@/db/index";
import { activityEvents, authRateLimits, authTokens, organisations, users } from "@/db/schema";
import { contextFor, fakeClock, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import type { AuthContext } from "@/lib/types";
import { DEMO_BLOCKED_MESSAGES, type DemoBlockedAction } from "@/server/auth/demo";
import { verifyPassword } from "@/server/auth/password";
import { issueToken } from "@/server/auth/tokens";
import { ForbiddenError } from "@/server/errors";
import { withTx } from "./_shared";
import { changePassword, preparePasswordChange, recordLogout } from "./auth";
import { createInvite, resendInvite, revokeInvite } from "./invites";
import { RESET_INVALID_MESSAGE, requestPasswordReset, resetPassword as resetWithLink } from "./passwordReset";
import {
  anonymiseUser,
  changeRole,
  deactivateUser,
  inviteUser,
  inviteUserByMethod,
  inviteUserWithTempPassword,
  resetPassword as adminResetPassword,
  resetPasswordWithTempPassword,
  setAdmin,
  setPermissions,
  transferPrimaryOwner,
  updateUser,
} from "./users";

let db: TestDb;
let ids: SeedIds;
/** A pending (never accepted) invitee of the demo studio, invited before it became the demo. */
let pendingId: string;

async function setDemo(isDemo: boolean, organisationId = ids.organisationId): Promise<void> {
  await db.update(organisations).set({ isDemo }).where(eq(organisations.id, organisationId));
}

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
  const ctx = await contextFor(db, ids.users.owner);
  const invited = await withTx((tx) => inviteUser(tx, ctx, { email: "pending@studio.test", name: "Pat Pending", role: "editor" }), { db });
  pendingId = invited.user.id;
  // Like the real seed: the studio is built through the services, THEN flagged as the demo.
  await setDemo(true);
});
afterEach(() => fakeClock.reset());

const asOwner = async () => contextFor(db, ids.users.owner);
const run = async <T>(ctx: AuthContext, fn: (tx: Tx) => Promise<T>) => withTx(fn, { db });
const version = async (userId: string) => (await first(db.select({ v: users.version }).from(users).where(eq(users.id, userId))))?.v ?? 0;
const eventCount = async () => Number((await db.select({ n: count() }).from(activityEvents))[0]?.n ?? 0);

/** Awaits a refusal and checks it is the demo 403 for `what`, with its plain copy. */
async function expectDemoRefusal(promise: Promise<unknown>, what: DemoBlockedAction): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected demo.${what}`).toBeInstanceOf(ForbiddenError);
  expect((err as ForbiddenError).action).toBe(`demo.${what}`);
  expect((err as ForbiddenError).status).toBe(403);
  expect((err as Error).message).toBe(DEMO_BLOCKED_MESSAGES[what]);
}

describe("contexts", () => {
  it("everyone in the demo studio carries isDemo; nobody in a real studio does", async () => {
    expect((await asOwner()).isDemo).toBe(true);
    expect((await contextFor(db, ids.users.client)).isDemo).toBe(true);
    const real = await seedMinimalOrg(db, { slug: "real", emailDomain: "real.test" });
    expect((await contextFor(db, real.users.owner)).isDemo).toBe(false);
  });
});

describe("invites are off", () => {
  it("inviteUser / inviteUserByMethod / inviteUserWithTempPassword (staff and client online access) → demo.invite, nothing created", async () => {
    const ctx = await asOwner();
    const before = await eventCount();
    await expectDemoRefusal(run(ctx, (tx) => inviteUser(tx, ctx, { email: "new@studio.test", name: "New", role: "editor" })), "invite");
    await expectDemoRefusal(inviteUserByMethod(ctx, { email: "new@studio.test", name: "New", role: "photographer" }, db), "invite");
    await expectDemoRefusal(inviteUserByMethod(ctx, { email: "new@studio.test", name: "New", role: "editor", method: "temp_password" }, db), "invite");
    await expectDemoRefusal(inviteUserWithTempPassword(ctx, { email: "new@studio.test", name: "New", role: "editor" }, db), "invite");
    // A client's online access (the client portal) is an invite too.
    await expectDemoRefusal(inviteUserByMethod(ctx, { email: "portal@studio.test", name: "Portal", role: "client", clientId: ids.clientId }, db), "invite");
    expect(await first(db.select().from(users).where(eq(users.email, "new@studio.test")))).toBeUndefined();
    expect(await first(db.select().from(users).where(eq(users.email, "portal@studio.test")))).toBeUndefined();
    expect(await eventCount()).toBe(before);
  });

  it("send a new link / resend / revoke for a pending person → demo.invite; their tokens are untouched", async () => {
    const ctx = await asOwner();
    const tokensBefore = await db.select().from(authTokens).where(eq(authTokens.userId, pendingId));
    await expectDemoRefusal(run(ctx, (tx) => createInvite(tx, ctx, { userId: pendingId })), "invite");
    await expectDemoRefusal(run(ctx, (tx) => resendInvite(tx, ctx, { userId: pendingId })), "invite");
    await expectDemoRefusal(run(ctx, (tx) => revokeInvite(tx, ctx, { userId: pendingId })), "invite");
    expect(await db.select().from(authTokens).where(eq(authTokens.userId, pendingId))).toEqual(tokensBefore);
  });
});

describe("passwords, emails and the persona accounts", () => {
  it("an admin's password reset / temp password → demo.reset_password; the password still works", async () => {
    const ctx = await asOwner();
    for (const userId of [ids.users.editor2, ids.users.editor1, pendingId]) {
      const expectedVersion = await version(userId);
      await expectDemoRefusal(run(ctx, (tx) => adminResetPassword(tx, ctx, { userId, expectedVersion })), "reset_password");
      await expectDemoRefusal(resetPasswordWithTempPassword(ctx, { userId, expectedVersion }, db), "reset_password");
    }
    const row = await first(db.select().from(users).where(eq(users.id, ids.users.editor2)));
    expect(await verifyPassword(ids.password, row?.passwordHash ?? "")).toBe(true);
  });

  it("changing your own password → demo.password (before any check is counted)", async () => {
    for (const key of ["owner", "editor1", "client"] as const) {
      const ctx = await contextFor(db, ids.users[key]);
      await expectDemoRefusal(preparePasswordChange(db, ctx, { current: ids.password, next: "SomethingNew123!" }), "password");
      await expectDemoRefusal(changePassword(ctx, { current: "wrong-wrong", next: "SomethingNew123!" }, db), "password");
    }
    expect(await db.select().from(authRateLimits)).toHaveLength(0);
  });

  it("an email change by an admin → demo.email; renaming someone (even with the same email sent along) still works", async () => {
    const ctx = await asOwner();
    await expectDemoRefusal(
      run(ctx, (tx) => updateUser(tx, ctx, { userId: ids.users.editor2, expectedVersion: 1, email: "renamed@studio.test" })),
      "email",
    );
    await expectDemoRefusal(run(ctx, (tx) => updateUser(tx, ctx, { userId: ids.users.owner, expectedVersion: 1, email: "me@studio.test" })), "email");
    const renamed = await run(ctx, (tx) => updateUser(tx, ctx, { userId: ids.users.editor1, expectedVersion: 1, name: "Eve Renamed", email: ids.emails.editor1 }));
    expect(renamed).toMatchObject({ name: "Eve Renamed", email: ids.emails.editor1 });
  });

  it("the four persona accounts can't be re-roled, promoted, re-switched, deactivated or anonymised → demo.demo_accounts", async () => {
    const ctx = await asOwner();
    await expectDemoRefusal(run(ctx, (tx) => changeRole(tx, ctx, { userId: ids.users.photographer1, role: "editor", expectedVersion: 1 })), "demo_accounts");
    await expectDemoRefusal(run(ctx, (tx) => changeRole(tx, ctx, { userId: ids.users.editor1, role: "photographer", expectedVersion: 1 })), "demo_accounts");
    await expectDemoRefusal(run(ctx, (tx) => setAdmin(tx, ctx, { userId: ids.users.photographer1, isAdmin: true, expectedVersion: 1 })), "demo_accounts");
    await expectDemoRefusal(run(ctx, (tx) => setPermissions(tx, ctx, { userId: ids.users.editor1, canCreateJobs: false, expectedVersion: 1 })), "demo_accounts");
    await expectDemoRefusal(run(ctx, (tx) => setPermissions(tx, ctx, { userId: ids.users.photographer1, canViewAllJobs: true, expectedVersion: 1 })), "demo_accounts");
    for (const key of ["photographer1", "editor1", "client"] as const) {
      await expectDemoRefusal(run(ctx, (tx) => deactivateUser(tx, ctx, { userId: ids.users[key], expectedVersion: 1 })), "demo_accounts");
    }
    // Even if a persona were found deactivated, it can't be anonymised.
    await db.update(users).set({ isActive: false }).where(eq(users.id, ids.users.editor1));
    await expectDemoRefusal(run(ctx, (tx) => anonymiseUser(tx, ctx, { userId: ids.users.editor1, expectedVersion: 1 })), "demo_accounts");
    // A co-admin can't deactivate the Owner persona either (the primary-owner rule refuses first, also a 403).
    const coAdmin = await contextFor(db, ids.users.coAdmin);
    const err = await run(coAdmin, (tx) => deactivateUser(tx, coAdmin, { userId: ids.users.owner, expectedVersion: 1 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    const rows = await db.select({ id: users.id, role: users.role, isAdmin: users.isAdmin, isActive: users.isActive }).from(users).where(eq(users.id, ids.users.photographer1));
    expect(rows[0]).toMatchObject({ role: "photographer", isAdmin: false, isActive: true });
  });

  it("the other people of the demo studio can still be managed (not personas)", async () => {
    const ctx = await asOwner();
    await expect(run(ctx, (tx) => setPermissions(tx, ctx, { userId: ids.users.editor2, canCreateJobs: false, expectedVersion: 1 }))).resolves.toMatchObject({ canCreateJobs: false });
    await expect(run(ctx, (tx) => setAdmin(tx, ctx, { userId: ids.users.photographer2, isAdmin: true, expectedVersion: 1 }))).resolves.toMatchObject({ isAdmin: true });
    await expect(run(ctx, (tx) => deactivateUser(tx, ctx, { userId: ids.users.editor2, expectedVersion: 2 }))).resolves.toMatchObject({ user: { isActive: false } });
  });

  it("primary ownership stays with the Owner persona → demo.demo_accounts", async () => {
    const ctx = await asOwner();
    await expectDemoRefusal(run(ctx, (tx) => transferPrimaryOwner(tx, ctx, { userId: ids.users.coAdmin, expectedVersion: 1 })), "demo_accounts");
  });
});

describe("password reset links", () => {
  it("'Forgot password' for a demo person answers ok but issues no token and records nothing", async () => {
    const before = await eventCount();
    for (const email of [ids.emails.owner, ids.emails.editor2, ids.emails.client]) {
      await expect(requestPasswordReset(db, { email, ip: "1.1.1.1" })).resolves.toEqual({ ok: true, emailed: false });
    }
    expect(await db.select().from(authTokens).where(eq(authTokens.kind, "password_reset"))).toHaveLength(0);
    expect(await eventCount()).toBe(before);
  });

  it("a reset link issued before the studio became the demo is dead: the generic 400, nothing changes", async () => {
    const issued = await withTx((tx) => issueToken(tx, { organisationId: ids.organisationId, userId: ids.users.editor1, kind: "password_reset", createdByUserId: null, now: fakeClock.now() }), { db });
    const err = await resetWithLink(db, { token: issued.token, password: "TakeOverDemo99!" }).catch((e: unknown) => e);
    expect((err as Error).message).toBe(RESET_INVALID_MESSAGE);
    const row = await first(db.select().from(users).where(eq(users.id, ids.users.editor1)));
    expect(await verifyPassword(ids.password, row?.passwordHash ?? "")).toBe(true);
    expect(row?.sessionVersion).toBe(1);
    const token = await first(db.select().from(authTokens).where(and(eq(authTokens.userId, ids.users.editor1), eq(authTokens.kind, "password_reset"))));
    expect(token?.usedAt).toBeNull();
  });
});

describe("signing out", () => {
  it("recordLogout in the demo studio revokes nothing (shared persona) but still records the sign-out", async () => {
    const ctx = await contextFor(db, ids.users.editor1);
    await expect(withTx((tx) => recordLogout(tx, ctx, { ip: "1.1.1.1" }), { db })).resolves.toBeNull();
    expect((await first(db.select().from(users).where(eq(users.id, ids.users.editor1))))?.sessionVersion).toBe(1);
    const [event] = await db.select().from(activityEvents).where(eq(activityEvents.eventType, "auth.logged_out"));
    expect(event.metadata).toMatchObject({ allSessionsRevoked: false, demo: true });
  });
});

describe("org isolation: a real studio beside the demo", () => {
  it("invites, password changes, resets and role changes all still work there", async () => {
    const real = await seedMinimalOrg(db, { slug: "real", emailDomain: "real.test" });
    const owner = await contextFor(db, real.users.owner);
    const invited = await withTx((tx) => inviteUser(tx, owner, { email: "newbie@real.test", name: "Newbie", role: "editor" }), { db });
    expect(invited.invite?.token).toBeTruthy();
    await expect(withTx((tx) => adminResetPassword(tx, owner, { userId: real.users.editor2, expectedVersion: 1 }), { db })).resolves.toMatchObject({ userId: real.users.editor2 });
    await expect(withTx((tx) => setPermissions(tx, owner, { userId: real.users.editor1, canCreateJobs: false, expectedVersion: 1 }), { db })).resolves.toMatchObject({ canCreateJobs: false });
    const editor = await contextFor(db, real.users.photographer1);
    await expect(preparePasswordChange(db, editor, { current: real.password, next: "SomethingNew123!" })).resolves.toMatchObject({ userId: real.users.photographer1 });
    await expect(requestPasswordReset(db, { email: real.emails.editor1, ip: "2.2.2.2" })).resolves.toMatchObject({ ok: true });
    expect(await db.select().from(authTokens).where(and(eq(authTokens.userId, real.users.editor1), eq(authTokens.kind, "password_reset")))).toHaveLength(1);
    // …and the demo studio is still the demo.
    await setDemo(true);
    expect((await asOwner()).isDemo).toBe(true);
  });
});
