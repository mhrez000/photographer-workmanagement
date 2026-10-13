import { compareSync } from "bcryptjs";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first, type Tx } from "@/db/index";
import { activityEvents, clients, jobAssignments, jobs, organisationSettings, organisations, userNotificationPrefs, users, workSessions } from "@/db/schema";
import {
  contextFor,
  dbRejection,
  fakeClock,
  insertJobFixture,
  makeTestDb,
  seedMinimalOrg,
  setUserFlags,
  testPasswordHash,
  type SeedIds,
  type TestDb,
} from "@/db/test-db";
import { CLIENT_NOTIFICATION_TYPES, MEMBER_INVITE_DEFAULTS } from "@/lib/constants";
import type { AuthContext } from "@/lib/types";
import { can } from "@/server/auth/permissions";
import { buildContextFromDb } from "@/server/auth/session";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { withTx } from "./_shared";
import { UserRuleError } from "./_admin";
import {
  EMAIL_UNAVAILABLE_MESSAGE,
  anonymiseUser,
  changeRole,
  deactivateUser,
  getNotificationPrefs,
  inviteUser,
  inviteUserWithTempPassword,
  listClientPortalUsers,
  prepareTempPassword,
  reactivateUser,
  resetPassword,
  setAdmin,
  setCapacity,
  setNotificationPrefs,
  setPermissions,
  transferPrimaryOwner,
  updateUser,
  userPermissionRef,
  type PreparedSecret,
} from "./users";

let db: TestDb;
let ids: SeedIds;
let secret: PreparedSecret;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db, { settings: { timeTrackingEnabled: true } });
  secret = await prepareTempPassword(4);
});
afterEach(() => fakeClock.reset());

async function run<T>(userId: string, fn: (tx: Tx, ctx: AuthContext) => Promise<T> | T): Promise<T> {
  const ctx = await contextFor(db, userId);
  return withTx((tx) => fn(tx, ctx), { db });
}
/** Runs as a context built BEFORE some concurrent change (a request already in flight). */
async function runAs<T>(ctx: AuthContext, fn: (tx: Tx, ctx: AuthContext) => Promise<T> | T): Promise<T> {
  return withTx((tx) => fn(tx, ctx), { db });
}
const userRow = async (id: string) => first(db.select().from(users).where(eq(users.id, id)));
const eventsOf = async (type: string) =>
  db.select().from(activityEvents).where(eq(activityEvents.eventType, type)).orderBy(activityEvents.createdAt, activityEvents.rowid);
const settingsRow = async () => first(db.select().from(organisationSettings).where(eq(organisationSettings.organisationId, ids.organisationId)));
const reason = (err: unknown) => (err instanceof UserRuleError ? err.reason : null);

async function startSession(jobId: string, userId: string, transitionId: string, statusId: string) {
  await db.insert(workSessions).values({
    organisationId: ids.organisationId,
    jobId,
    userId,
    statusIdAtStart: statusId,
    categoryAtStart: "in_progress",
    transitionId,
    startedAt: "2026-10-07T23:00:00.000Z",
  });
}

/* ------------------------------------------------------------------ */

describe("inviteUser", () => {
  it("creates the user with a one-time temp password and a management event without secrets", async () => {
    const res = await run(ids.users.coAdmin, (tx, ctx) =>
      inviteUser(tx, ctx, { email: " New.Editor@Studio.test ", name: "Nia New", role: "editor", capacityHoursPerWeek: 30 }, secret),
    );
    expect(res.tempPassword).toBe(secret.tempPassword);
    expect(res.user).toMatchObject({ email: "new.editor@studio.test", role: "editor", isActive: true, capacityHoursPerWeek: 30, isAdmin: false });
    expect(res.user).not.toHaveProperty("passwordHash");
    expect(compareSync(res.tempPassword, (await userRow(res.user.id))?.passwordHash ?? "")).toBe(true);

    const [ev] = await eventsOf("user.created");
    expect(ev).toMatchObject({ entityId: res.user.id, visibility: "management", actorUserId: ids.users.coAdmin });
    expect(ev.newValue).toMatchObject({ role: "editor", isAdmin: false, clientId: null, flags: { canCreateJobs: false, canViewTeamJobs: false } });
    expect(JSON.stringify([ev.newValue, ev.previousValue, ev.metadata])).not.toMatch(/password|\$2[aby]\$/i);
    expect(ev.summary).toBe("invited Nia New as Editor");
  });

  it("only admins invite (a fully-switched team member cannot); emails are globally unique (409, no org/role)", async () => {
    await expect(run(ids.users.lead, (tx, ctx) => inviteUser(tx, ctx, { email: "x@studio.test", name: "X", role: "editor" }, secret))).rejects.toThrow(
      ForbiddenError,
    );
    await expect(run(ids.users.photographer1, (tx, ctx) => inviteUser(tx, ctx, { email: "x@studio.test", name: "X", role: "editor" }, secret))).rejects.toThrow(
      ForbiddenError,
    );
    await expect(run(ids.users.editor1, (tx, ctx) => inviteUser(tx, ctx, { email: "x@studio.test", name: "X", role: "photographer" }, secret))).rejects.toThrow(
      ForbiddenError,
    );
    const dup = await run(ids.users.owner, (tx, ctx) => inviteUser(tx, ctx, { email: ids.emails.editor1, name: "Dup", role: "editor" }, secret)).catch(
      (e: unknown) => e,
    );
    expect(dup).toBeInstanceOf(ConflictError);
    expect((dup as ConflictError).status).toBe(409);
    expect((dup as Error).message).toBe(EMAIL_UNAVAILABLE_MESSAGE);
    // the same for an address used by ANOTHER organisation — and the message names neither
    const other = await seedMinimalOrg(db, { slug: "other" });
    const foreign = await run(ids.users.owner, (tx, ctx) => inviteUser(tx, ctx, { email: other.emails.editor1, name: "Dup", role: "editor" }, secret)).catch(
      (e: unknown) => e,
    );
    expect((foreign as Error).message).toBe(EMAIL_UNAVAILABLE_MESSAGE);
    expect(await eventsOf("user.created")).toHaveLength(0);
  });

  it("a team member gets the INVITE defaults (review ✗); omitted switches never fall back to the column defaults", async () => {
    const res = await run(ids.users.owner, (tx, ctx) => inviteUser(tx, ctx, { email: "p@studio.test", name: "Pat", role: "photographer" }, secret));
    const row = await userRow(res.user.id);
    expect(row).toMatchObject({ isAdmin: false, ...MEMBER_INVITE_DEFAULTS, canReviewSubmissions: false, canViewTeamJobs: false });
    const ctx = await contextFor(db, res.user.id);
    expect(ctx).toMatchObject({ isAdmin: false, canCreateJobs: true, canAssignEditors: true, canReviewSubmissions: false, canViewAllJobs: false });
    const [ev] = await eventsOf("user.created");
    expect(ev.newValue).toMatchObject({
      role: "photographer",
      isAdmin: false,
      flags: { canCreateJobs: true, canAssignEditors: true, canReviewSubmissions: false, canViewTeamWorkloads: false, canViewAllJobs: false, canViewAnalytics: false },
    });
    expect((ev.newValue as { flags: object }).flags).not.toHaveProperty("canViewTeamJobs");
  });

  it("switches from the dialog are applied; editors take only editor switches", async () => {
    const p = await run(ids.users.owner, (tx, ctx) =>
      inviteUser(tx, ctx, { email: "senior@studio.test", name: "Sam", role: "photographer", flags: { canReviewSubmissions: true, canViewAllJobs: true, canAssignEditors: false } }, secret),
    );
    expect(await userRow(p.user.id)).toMatchObject({ canReviewSubmissions: true, canViewAllJobs: true, canAssignEditors: false, canCreateJobs: true });
    const e = await run(ids.users.owner, (tx, ctx) =>
      inviteUser(tx, ctx, { email: "ed3@studio.test", name: "Edd", role: "editor", flags: { canCreateJobs: false, canViewTeamJobs: true } }, secret),
    );
    expect(await contextFor(db, e.user.id)).toMatchObject({ canCreateJobs: false, canViewTeamJobs: true, canReviewSubmissions: false });
    // strict per role: member switches on an editor, client fields on staff, unknown keys → 400
    for (const body of [
      { email: "a@studio.test", name: "A", role: "editor", flags: { canAssignEditors: true } },
      { email: "a@studio.test", name: "A", role: "editor", isAdmin: true },
      { email: "a@studio.test", name: "A", role: "photographer", clientId: ids.clientId },
      { email: "a@studio.test", name: "A", role: "photographer", flags: { canViewTeamJobs: true } },
      { email: "a@studio.test", name: "A", role: "photographer", canViewAnalytics: true },
      { email: "a@studio.test", name: "A", role: "manager" },
      { email: "a@studio.test", name: "A", role: "owner" },
    ]) {
      await expect(run(ids.users.owner, (tx, ctx) => inviteUser(tx, ctx, body, secret))).rejects.toThrow(ValidationError);
    }
    expect(await first(db.select().from(users).where(eq(users.email, "a@studio.test")))).toBeUndefined();
  });

  it("isAdmin invites a co-owner (needs user.set_admin)", async () => {
    const res = await run(ids.users.coAdmin, (tx, ctx) =>
      inviteUser(tx, ctx, { email: "co@studio.test", name: "Corey", role: "photographer", isAdmin: true, title: "Partner" }, secret),
    );
    expect(res.user).toMatchObject({ role: "photographer", isAdmin: true, title: "Partner" });
    expect(await contextFor(db, res.user.id)).toMatchObject({ isAdmin: true, isPrimaryOwner: false, canViewAnalytics: true });
    expect((await eventsOf("user.created"))[0].newValue).toMatchObject({ isAdmin: true, flags: {} });
  });

  it("client users: required clientId of a non-archived, portal-enabled client of the org; no flags/capacity/admin/title", async () => {
    const res = await run(ids.users.owner, (tx, ctx) =>
      inviteUser(tx, ctx, { email: "buyer@harbour.test", name: "Bea Buyer", role: "client", clientId: ids.clientId }, secret),
    );
    const row = await userRow(res.user.id);
    expect(row).toMatchObject({ role: "client", clientId: ids.clientId, isAdmin: false, canCreateJobs: false, canReviewSubmissions: false, capacityHoursPerWeek: null });
    const ctx = await contextFor(db, res.user.id);
    expect(ctx).toMatchObject({ role: "client", clientId: ids.clientId, clientFeedbackEnabled: true, canCreateJobs: false });
    const [ev] = await eventsOf("user.created");
    expect(ev.newValue).toMatchObject({ role: "client", clientId: ids.clientId, flags: {} });
    expect(ev.metadata).toMatchObject({ clientName: "Harbour Realty" });

    const invite = (body: Record<string, unknown>) =>
      run(ids.users.owner, (tx, ctx) => inviteUser(tx, ctx, { email: "c2@harbour.test", name: "C", role: "client", ...body }, secret));
    await expect(invite({})).rejects.toThrow(ValidationError); // clientId required
    await expect(invite({ clientId: ids.clientId, capacityHoursPerWeek: 10 })).rejects.toThrow(ValidationError);
    await expect(invite({ clientId: ids.clientId, isAdmin: true })).rejects.toThrow(ValidationError);
    await expect(invite({ clientId: ids.clientId, flags: { canCreateJobs: true } })).rejects.toThrow(ValidationError);
    await expect(invite({ clientId: ids.clientId, title: "CEO" })).rejects.toThrow(ValidationError);

    await db.update(clients).set({ portalEnabled: false }).where(eq(clients.id, ids.clientId2));
    const off = await invite({ clientId: ids.clientId2 }).catch((e: unknown) => e);
    expect(off).toBeInstanceOf(UserRuleError);
    expect((off as UserRuleError).status).toBe(422);
    expect((off as Error).message).toBe("Turn on the client portal for this client first");

    await db.update(clients).set({ portalEnabled: true, archivedAt: "2026-10-01T00:00:00.000Z" }).where(eq(clients.id, ids.clientId2));
    await expect(invite({ clientId: ids.clientId2 })).rejects.toMatchObject({ status: 422 });

    const other = await seedMinimalOrg(db, { slug: "other" });
    await expect(invite({ clientId: other.clientId })).rejects.toThrow(NotFoundError);
    expect(await eventsOf("user.created")).toHaveLength(1);
  });

  it("async convenience hashes outside the transaction", async () => {
    const res = await inviteUserWithTempPassword(await contextFor(db, ids.users.owner), { email: "async@studio.test", name: "Ash", role: "photographer" }, db);
    expect(res.tempPassword.length).toBeGreaterThanOrEqual(14);
    expect(compareSync(res.tempPassword, (await userRow(res.user.id))?.passwordHash ?? "")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe("updateUser", () => {
  it("self edits name/title/avatar; email or other users need admin", async () => {
    const me = await run(ids.users.editor1, (tx, ctx) => updateUser(tx, ctx, { userId: ids.users.editor1, name: "Eve E.", title: "Senior editor" }));
    expect(me).toMatchObject({ name: "Eve E.", title: "Senior editor", version: 2 });
    expect((await eventsOf("user.updated"))[0].metadata).toMatchObject({ self: true, targetName: "Eve E." });

    await expect(run(ids.users.editor1, (tx, ctx) => updateUser(tx, ctx, { userId: ids.users.editor1, email: "eve@x.test" }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.lead, (tx, ctx) => updateUser(tx, ctx, { userId: ids.users.lead, email: "leo@x.test" }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.editor1, (tx, ctx) => updateUser(tx, ctx, { userId: ids.users.editor2, name: "Hacked" }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.lead, (tx, ctx) => updateUser(tx, ctx, { userId: ids.users.editor2, name: "Hacked" }))).rejects.toThrow(ForbiddenError);
    // a co-admin cannot touch the primary owner (§3.4 hard rule)
    await expect(run(ids.users.coAdmin, (tx, ctx) => updateUser(tx, ctx, { userId: ids.users.owner, name: "Boss" }))).rejects.toThrow(ForbiddenError);

    const byAdmin = await run(ids.users.coAdmin, (tx, ctx) => updateUser(tx, ctx, { userId: ids.users.editor2, email: "Ed@Studio.test" }));
    expect(byAdmin.email).toBe("ed@studio.test");
    const dup = await run(ids.users.coAdmin, (tx, ctx) => updateUser(tx, ctx, { userId: ids.users.editor2, email: ids.emails.editor1 })).catch((e: unknown) => e);
    expect(dup).toBeInstanceOf(ConflictError);
    expect((dup as Error).message).toBe(EMAIL_UNAVAILABLE_MESSAGE);
  });

  it("the primary owner edits their own profile and email; admins change their own email", async () => {
    const owner = await run(ids.users.owner, (tx, ctx) => updateUser(tx, ctx, { userId: ids.users.owner, name: "Olivia O.", email: "olivia@studio.test" }));
    expect(owner).toMatchObject({ name: "Olivia O.", email: "olivia@studio.test" });
    const co = await run(ids.users.coAdmin, (tx, ctx) => updateUser(tx, ctx, { userId: ids.users.coAdmin, email: "cora@studio.test" }));
    expect(co.email).toBe("cora@studio.test");
  });

  it("client users change only their name; admins edit client users", async () => {
    const me = await run(ids.users.client, (tx, ctx) => updateUser(tx, ctx, { userId: ids.users.client, name: "Cleo C." }));
    expect(me.name).toBe("Cleo C.");
    await expect(run(ids.users.client, (tx, ctx) => updateUser(tx, ctx, { userId: ids.users.client, title: "Agent" }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.client, (tx, ctx) => updateUser(tx, ctx, { userId: ids.users.client, email: "c@x.test" }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.client, (tx, ctx) => updateUser(tx, ctx, { userId: ids.users.client2, name: "X" }))).rejects.toThrow(ForbiddenError);
    const byAdmin = await run(ids.users.owner, (tx, ctx) => updateUser(tx, ctx, { userId: ids.users.client, email: "cleo@harbour.test" }));
    expect(byAdmin.email).toBe("cleo@harbour.test");
  });

  it("strict: role, admin, client link and switches are not profile fields (400, no change)", async () => {
    for (const key of ["role", "isAdmin", "clientId", "canViewAllJobs", "canReviewSubmissions", "canViewTeamJobs", "sessionVersion"]) {
      const value = key === "role" ? "editor" : key === "clientId" ? ids.clientId : key === "sessionVersion" ? 9 : true;
      await expect(run(ids.users.owner, (tx, ctx) => updateUser(tx, ctx, { userId: ids.users.photographer1, name: "P", [key]: value }))).rejects.toThrow(
        ValidationError,
      );
    }
    expect(await userRow(ids.users.photographer1)).toMatchObject({ name: "Pia Photographer", role: "photographer", isAdmin: false, version: 1 });
    expect(await eventsOf("user.updated")).toHaveLength(0);
  });

  it("foreign users are 404", async () => {
    const other = await seedMinimalOrg(db, { slug: "other" });
    await expect(run(ids.users.owner, (tx, ctx) => updateUser(tx, ctx, { userId: other.users.editor1, name: "X" }))).rejects.toThrow(NotFoundError);
    await expect(run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: other.users.editor1 }))).rejects.toThrow(NotFoundError);
    await expect(run(ids.users.owner, (tx, ctx) => setAdmin(tx, ctx, { userId: other.users.photographer1, isAdmin: true }))).rejects.toThrow(NotFoundError);
    await expect(run(ids.users.owner, (tx, ctx) => setPermissions(tx, ctx, { userId: other.users.editor1, canViewTeamJobs: true }))).rejects.toThrow(
      NotFoundError,
    );
    await expect(run(ids.users.owner, (tx, ctx) => transferPrimaryOwner(tx, ctx, { userId: other.users.owner }))).rejects.toThrow(NotFoundError);
  });
});

/* ------------------------------------------------------------------ */

describe("changeRole", () => {
  it("admins switch photographer ⇄ editor; the session is revoked and audited", async () => {
    const res = await run(ids.users.coAdmin, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.photographer2, role: "editor", expectedVersion: 1 }));
    expect(res.role).toBe("editor");
    expect((await userRow(ids.users.photographer2))?.sessionVersion).toBe(2);
    expect((await eventsOf("user.role_changed"))[0]).toMatchObject({
      previousValue: { role: "photographer", isAdmin: false, name: "Paul Photographer" },
      newValue: { role: "editor", isAdmin: false },
    });
  });

  it("no self, no primary owner (others), no non-admin; legacy roles are not roles any more", async () => {
    await expect(run(ids.users.coAdmin, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.coAdmin, role: "editor" }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.coAdmin, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.owner, role: "editor" }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.owner, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.owner, role: "editor" }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.lead, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.editor2, role: "photographer" }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.editor1, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.editor2, role: "photographer" }))).rejects.toThrow(ForbiddenError);
    // v1 "manager"/"owner" targets no longer exist: the schema rejects them
    await expect(run(ids.users.owner, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.editor2, role: "manager" }))).rejects.toThrow(ValidationError);
    await expect(run(ids.users.owner, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.editor2, role: "owner" }))).rejects.toThrow(ValidationError);
    expect(await eventsOf("user.role_changed")).toHaveLength(0);
  });

  it("client ⇄ staff is impossible: 422 role_change_not_allowed", async () => {
    const toClient = await run(ids.users.owner, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.editor1, role: "client" })).catch((e: unknown) => e);
    expect(reason(toClient)).toBe("role_change_not_allowed");
    expect((toClient as UserRuleError).status).toBe(422);
    const fromClient = await run(ids.users.owner, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.client, role: "photographer" })).catch((e: unknown) => e);
    expect(reason(fromClient)).toBe("role_change_not_allowed");
    expect(await userRow(ids.users.client)).toMatchObject({ role: "client", clientId: ids.clientId });
  });

  it("resets the NEW role's switches to the invite defaults (metadata.flagsReset)", async () => {
    await setUserFlags(db, ids.users.editor1, { canCreateJobs: false, canViewTeamJobs: true });
    const asPhotographer = await run(ids.users.owner, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.editor1, role: "photographer" }));
    expect(asPhotographer.role).toBe("photographer");
    expect(await userRow(ids.users.editor1)).toMatchObject({ ...MEMBER_INVITE_DEFAULTS });
    const [ev] = await eventsOf("user.role_changed");
    expect(ev.metadata).toMatchObject({
      flagsReset: { canCreateJobs: { from: false, to: true }, canReviewSubmissions: { from: true, to: false } },
    });
    expect(await contextFor(db, ids.users.editor1)).toMatchObject({ role: "photographer", isAdmin: false, canReviewSubmissions: false, canViewTeamJobs: false });

    await setUserFlags(db, ids.users.photographer2, { canCreateJobs: false });
    await run(ids.users.owner, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.photographer2, role: "editor" }));
    expect(await contextFor(db, ids.users.photographer2)).toMatchObject({ role: "editor", canCreateJobs: false, canViewTeamJobs: false });
  });

  it("photographer → editor clears admin (two events); the primary owner cannot be re-roled", async () => {
    const res = await run(ids.users.owner, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.coAdmin, role: "editor" }));
    expect(res).toMatchObject({ role: "editor", isAdmin: false });
    expect((await eventsOf("user.role_changed"))[0]).toMatchObject({ previousValue: { isAdmin: true }, newValue: { isAdmin: false } });
    const [admin] = await eventsOf("user.admin_changed");
    expect(admin).toMatchObject({ entityId: ids.users.coAdmin, previousValue: { isAdmin: true }, newValue: { isAdmin: false } });
    expect(admin.metadata).toMatchObject({ reason: "role_changed" });
  });

  it("refuses to strand open assignments (photographer with open photographer jobs cannot become an editor)", async () => {
    await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 });
    await expect(run(ids.users.owner, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.editor1, role: "photographer" }))).rejects.toThrow(
      /open editing job/,
    );
    await insertJobFixture(db, ids, { statusKey: "new", photographerId: ids.users.photographer2 });
    await expect(run(ids.users.owner, (tx, ctx) => changeRole(tx, ctx, { userId: ids.users.photographer2, role: "editor" }))).rejects.toThrow(
      /photographer on/,
    );
  });
});

/* ------------------------------------------------------------------ */

describe("setAdmin", () => {
  it("grants and revokes admin on another active photographer; revoking restores the stored member switches", async () => {
    await setUserFlags(db, ids.users.photographer1, { canViewAllJobs: true, canReviewSubmissions: false });
    const granted = await run(ids.users.owner, (tx, ctx) => setAdmin(tx, ctx, { userId: ids.users.photographer1, isAdmin: true, expectedVersion: 2 }));
    expect(granted).toMatchObject({ isAdmin: true, version: 3 });
    expect(await contextFor(db, ids.users.photographer1)).toMatchObject({ isAdmin: true, canReviewSubmissions: true, canViewAnalytics: true });
    expect((await userRow(ids.users.photographer1))?.sessionVersion).toBe(2);

    const revoked = await run(ids.users.coAdmin, (tx, ctx) => setAdmin(tx, ctx, { userId: ids.users.photographer1, isAdmin: false }));
    expect(revoked.isAdmin).toBe(false);
    expect(await contextFor(db, ids.users.photographer1)).toMatchObject({ isAdmin: false, canViewAllJobs: true, canReviewSubmissions: false });
    expect((await userRow(ids.users.photographer1))?.sessionVersion).toBe(3);

    const events = await eventsOf("user.admin_changed");
    expect(events.map((e) => [e.previousValue, e.newValue, e.actorUserId])).toEqual([
      [{ isAdmin: false, name: "Pia Photographer" }, { isAdmin: true, name: "Pia Photographer" }, ids.users.owner],
      [{ isAdmin: true, name: "Pia Photographer" }, { isAdmin: false, name: "Pia Photographer" }, ids.users.coAdmin],
    ]);
    expect(events.every((e) => e.visibility === "management")).toBe(true);
  });

  it("no-op when unchanged; stale version → 409", async () => {
    expect((await run(ids.users.owner, (tx, ctx) => setAdmin(tx, ctx, { userId: ids.users.coAdmin, isAdmin: true }))).version).toBe(1);
    await expect(run(ids.users.owner, (tx, ctx) => setAdmin(tx, ctx, { userId: ids.users.lead, isAdmin: true, expectedVersion: 5 }))).rejects.toThrow(
      ConflictError,
    );
    expect(await eventsOf("user.admin_changed")).toHaveLength(0);
  });

  it("targets: active photographers only, never self; members/editors/clients cannot grant", async () => {
    const attempt = (actor: string, userId: string, isAdmin = true) => run(actor, (tx, ctx) => setAdmin(tx, ctx, { userId, isAdmin }));
    await expect(attempt(ids.users.owner, ids.users.editor1)).rejects.toThrow(ForbiddenError);
    await expect(attempt(ids.users.owner, ids.users.client)).rejects.toThrow(ForbiddenError);
    await db.update(users).set({ isActive: false }).where(eq(users.id, ids.users.photographer2));
    await expect(attempt(ids.users.owner, ids.users.photographer2)).rejects.toThrow(ForbiddenError);
    await expect(attempt(ids.users.coAdmin, ids.users.coAdmin, false)).rejects.toThrow(ForbiddenError);
    await expect(attempt(ids.users.lead, ids.users.photographer1)).rejects.toThrow(ForbiddenError);
    await expect(attempt(ids.users.editor1, ids.users.photographer1)).rejects.toThrow(ForbiddenError);
    expect(await eventsOf("user.admin_changed")).toHaveLength(0);
  });

  it("strict input", async () => {
    await expect(run(ids.users.owner, (tx, ctx) => setAdmin(tx, ctx, { userId: ids.users.lead }))).rejects.toThrow(ValidationError);
    await expect(run(ids.users.owner, (tx, ctx) => setAdmin(tx, ctx, { userId: ids.users.lead, isAdmin: true, role: "editor" }))).rejects.toThrow(ValidationError);
  });
});

/* ------------------------------------------------------------------ */

describe("primary owner protection (§3.4)", () => {
  it("a co-admin cannot revoke, re-role, deactivate, re-email, rename or reset the primary owner (403, nothing written)", async () => {
    const co = (fn: (tx: Tx, ctx: AuthContext) => Promise<unknown>) => run(ids.users.coAdmin, fn);
    await expect(co((tx, ctx) => setAdmin(tx, ctx, { userId: ids.users.owner, isAdmin: false }))).rejects.toThrow(ForbiddenError);
    await expect(co((tx, ctx) => changeRole(tx, ctx, { userId: ids.users.owner, role: "editor" }))).rejects.toThrow(ForbiddenError);
    await expect(co((tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.owner }))).rejects.toThrow(ForbiddenError);
    await expect(co((tx, ctx) => updateUser(tx, ctx, { userId: ids.users.owner, email: "takeover@studio.test" }))).rejects.toThrow(ForbiddenError);
    await expect(co((tx, ctx) => updateUser(tx, ctx, { userId: ids.users.owner, name: "Not Olivia" }))).rejects.toThrow(ForbiddenError);
    await expect(co((tx, ctx) => resetPassword(tx, ctx, { userId: ids.users.owner }, secret))).rejects.toThrow(ForbiddenError);
    // anonymise needs a deactivated target, which the primary owner can never be; the rule still denies it
    const coCtx = await contextFor(db, ids.users.coAdmin);
    const ownerRow = await userRow(ids.users.owner);
    if (!ownerRow) throw new Error("owner missing");
    expect(can(coCtx, "user.anonymise", { ...userPermissionRef(ownerRow, { primaryOwnerId: ids.users.owner }), isActive: false })).toBe(false);

    expect(await userRow(ids.users.owner)).toMatchObject({ isAdmin: true, isActive: true, role: "photographer", email: ids.emails.owner, sessionVersion: 1, version: 1 });
    expect(await db.select().from(activityEvents)).toHaveLength(0);
  });

  it("the DB trigger is the backstop: raw demotion / deactivation of the primary owner is rejected", async () => {
    expect(await dbRejection(db.update(users).set({ isAdmin: false }).where(eq(users.id, ids.users.owner)))).toMatch(
      /the primary owner must stay an active admin; transfer primary ownership first/,
    );
    expect(await dbRejection(db.update(users).set({ isActive: false }).where(eq(users.id, ids.users.owner)))).toMatch(/primary owner/);
    expect(await dbRejection(db.update(users).set({ role: "editor", isAdmin: false }).where(eq(users.id, ids.users.owner)))).toMatch(/primary owner/);
    expect(await dbRejection(db.update(organisationSettings).set({ primaryOwnerUserId: ids.users.lead }))).toMatch(
      /the primary owner must be an active admin of the organisation/,
    );
    expect(await dbRejection(db.update(organisationSettings).set({ primaryOwnerUserId: null }))).toMatch(/the primary owner cannot be cleared/);
  });

  it("transfer: only the primary owner, to another active admin; the old owner stays an admin", async () => {
    await expect(run(ids.users.coAdmin, (tx, ctx) => transferPrimaryOwner(tx, ctx, { userId: ids.users.coAdmin }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.owner, (tx, ctx) => transferPrimaryOwner(tx, ctx, { userId: ids.users.lead }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.owner, (tx, ctx) => transferPrimaryOwner(tx, ctx, { userId: ids.users.owner }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.owner, (tx, ctx) => transferPrimaryOwner(tx, ctx, { userId: ids.users.coAdmin, expectedVersion: 9 }))).rejects.toThrow(
      ConflictError,
    );

    const res = await run(ids.users.owner, (tx, ctx) => transferPrimaryOwner(tx, ctx, { userId: ids.users.coAdmin, expectedVersion: 1 }));
    expect(res).toEqual({ primaryOwnerUserId: ids.users.coAdmin, previousPrimaryOwnerUserId: ids.users.owner, settingsVersion: 2 });
    expect(await settingsRow()).toMatchObject({ primaryOwnerUserId: ids.users.coAdmin, version: 2 });
    expect(await contextFor(db, ids.users.coAdmin)).toMatchObject({ isAdmin: true, isPrimaryOwner: true });
    expect(await contextFor(db, ids.users.owner)).toMatchObject({ isAdmin: true, isPrimaryOwner: false });
    const [ev] = await eventsOf("settings.primary_owner_changed");
    expect(ev).toMatchObject({
      entityType: "settings",
      entityId: ids.organisationId,
      visibility: "management",
      previousValue: { userId: ids.users.owner, name: "Olivia Owner" },
      newValue: { userId: ids.users.coAdmin, name: "Cora Co-Admin" },
    });

    // the protection follows the title: the old owner is now an ordinary admin, the new one is protected
    await expect(run(ids.users.owner, (tx, ctx) => setAdmin(tx, ctx, { userId: ids.users.coAdmin, isAdmin: false }))).rejects.toThrow(ForbiddenError);
    const demoted = await run(ids.users.coAdmin, (tx, ctx) => setAdmin(tx, ctx, { userId: ids.users.owner, isAdmin: false }));
    expect(demoted.isAdmin).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("last-admin guard", () => {
  /** An organisation without a primary owner (only possible before 0003's backfill) with two admins. */
  async function orphanOrg(): Promise<{ a: string; b: string }> {
    const at = "2026-10-08T00:00:00.000Z";
    await db.insert(organisations).values({ id: "orphan-org", name: "Orphan", slug: "orphan", createdAt: at, updatedAt: at });
    await db.insert(organisationSettings).values({ organisationId: "orphan-org", updatedAt: at });
    const base = { organisationId: "orphan-org", passwordHash: testPasswordHash(), role: "photographer" as const, isAdmin: true, createdAt: at, updatedAt: at };
    await db.insert(users).values([
      { ...base, id: "orphan-a", email: "a@orphan.test", name: "Ada Admin" },
      { ...base, id: "orphan-b", email: "b@orphan.test", name: "Ben Admin" },
    ]);
    return { a: "orphan-a", b: "orphan-b" };
  }

  it("service: the last active admin keeps admin (422 last_admin) — a request in flight after the other admin left", async () => {
    const { a, b } = await orphanOrg();
    const staleA = await contextFor(db, a);
    // A is deactivated by B while A's request is in flight (allowed: B remains an admin)
    await db.update(users).set({ isActive: false }).where(eq(users.id, a));
    const attempts: ((tx: Tx, ctx: AuthContext) => Promise<unknown>)[] = [
      (tx: Tx, ctx: AuthContext) => setAdmin(tx, ctx, { userId: b, isAdmin: false }),
      (tx: Tx, ctx: AuthContext) => deactivateUser(tx, ctx, { userId: b }),
      (tx: Tx, ctx: AuthContext) => changeRole(tx, ctx, { userId: b, role: "editor" }),
    ];
    for (const attempt of attempts) {
      const err = await runAs(staleA, attempt).catch((e: unknown) => e);
      expect(reason(err)).toBe("last_admin");
      expect((err as UserRuleError).status).toBe(422);
      expect((err as Error).message).toMatch(/Make another photographer an admin first/);
    }
    expect(await userRow(b)).toMatchObject({ isAdmin: true, isActive: true, role: "photographer" });
  });

  it("trigger: sequential demotions of the last two admins — the second is rejected", async () => {
    const { a, b } = await orphanOrg();
    await db.update(users).set({ isAdmin: false }).where(eq(users.id, a));
    expect(await dbRejection(db.update(users).set({ isAdmin: false }).where(eq(users.id, b)))).toMatch(/an organisation must keep at least one active admin/);
    expect(await dbRejection(db.update(users).set({ isActive: false }).where(eq(users.id, b)))).toMatch(/at least one active admin/);
    expect(await dbRejection(db.update(users).set({ role: "editor", isAdmin: false }).where(eq(users.id, b)))).toMatch(/at least one active admin/);
    expect((await userRow(b))?.isAdmin).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe("setPermissions", () => {
  it("member switches on a team member, audited (changed switches only), effective on the next request without signing them out", async () => {
    const p = await run(ids.users.owner, (tx, ctx) =>
      setPermissions(tx, ctx, { userId: ids.users.photographer1, canViewAnalytics: true, canCreateJobs: true, canReviewSubmissions: false }),
    );
    expect(p).toMatchObject({ canViewAnalytics: true, canReviewSubmissions: false });
    const [ev] = await eventsOf("user.flags_changed");
    expect(ev).toMatchObject({
      previousValue: { canViewAnalytics: false, canReviewSubmissions: true },
      newValue: { canViewAnalytics: true, canReviewSubmissions: false },
      visibility: "management",
    });
    expect(ev.metadata).toMatchObject({ changedFlags: ["canReviewSubmissions", "canViewAnalytics"] });
    expect(await contextFor(db, ids.users.photographer1)).toMatchObject({ canViewAnalytics: true, canReviewSubmissions: false });
    // The existing session stays valid and already carries the new switches (context rebuilt per request).
    expect((await userRow(ids.users.photographer1))?.sessionVersion).toBe(1);
    expect(await buildContextFromDb(db, ids.users.photographer1, { sessionVersion: 1 })).toMatchObject({ canViewAnalytics: true, canReviewSubmissions: false });

    // nothing changed → no event, no version bump
    await run(ids.users.owner, (tx, ctx) => setPermissions(tx, ctx, { userId: ids.users.photographer1, canViewAnalytics: true }));
    expect(await eventsOf("user.flags_changed")).toHaveLength(1);
    await expect(run(ids.users.owner, (tx, ctx) => setPermissions(tx, ctx, { userId: ids.users.photographer1 }))).rejects.toThrow(ValidationError);
  });

  it("editor switches on an editor", async () => {
    await run(ids.users.coAdmin, (tx, ctx) => setPermissions(tx, ctx, { userId: ids.users.editor2, canViewTeamJobs: true, canCreateJobs: false }));
    expect(await contextFor(db, ids.users.editor2)).toMatchObject({ canViewTeamJobs: true, canCreateJobs: false });
  });

  it("validation: admins have every permission; switches outside the role, clients, inactive users and non-admin actors are refused", async () => {
    const attempt = (actor: string, body: Record<string, unknown>) => run(actor, (tx, ctx) => setPermissions(tx, ctx, body));
    expect(reason(await attempt(ids.users.owner, { userId: ids.users.coAdmin, canViewAllJobs: false }).catch((e: unknown) => e))).toBe(
      "admin_has_every_permission",
    );
    expect(reason(await attempt(ids.users.owner, { userId: ids.users.editor1, canReviewSubmissions: true }).catch((e: unknown) => e))).toBe("flag_not_for_role");
    expect(reason(await attempt(ids.users.owner, { userId: ids.users.photographer1, canViewTeamJobs: true }).catch((e: unknown) => e))).toBe(
      "flag_not_for_role",
    );
    expect(reason(await attempt(ids.users.owner, { userId: ids.users.client, canCreateJobs: true }).catch((e: unknown) => e))).toBe("not_staff");
    await expect(attempt(ids.users.owner, { userId: ids.users.inactiveEditor, canCreateJobs: false })).rejects.toThrow(ForbiddenError);
    await expect(attempt(ids.users.lead, { userId: ids.users.photographer1, canViewAllJobs: true })).rejects.toThrow(ForbiddenError);
    await expect(attempt(ids.users.editor1, { userId: ids.users.editor1, canViewTeamJobs: true })).rejects.toThrow(ForbiddenError);
    await expect(attempt(ids.users.owner, { userId: ids.users.photographer1, isAdmin: true })).rejects.toThrow(ValidationError);
    expect(await eventsOf("user.flags_changed")).toHaveLength(0);
    expect(await userRow(ids.users.editor1)).toMatchObject({ version: 1, sessionVersion: 1 });
  });
});

/* ------------------------------------------------------------------ */

describe("deactivateUser", () => {
  it("reassigns open editor jobs, stops the timer, bumps session_version and audits the job list", async () => {
    const a = await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 });
    const b = await insertJobFixture(db, ids, { statusKey: "assigned", editorId: ids.users.editor1 });
    const done = await insertJobFixture(db, ids, { statusKey: "completed", editorId: ids.users.editor1 });
    await startSession(a.job.id, ids.users.editor1, a.transitionId, ids.statuses.in_progress);
    fakeClock.advanceHours(1);

    const res = await run(ids.users.coAdmin, (tx, ctx) =>
      deactivateUser(tx, ctx, { userId: ids.users.editor1, reassignTo: ids.users.editor2, expectedVersion: 1 }),
    );
    expect(res.user).toMatchObject({ isActive: false, deactivatedByUserId: ids.users.coAdmin, deactivatedAt: "2026-10-08T01:00:00.000Z" });
    expect(res.openJobs.map((j) => [j.jobId, j.action]).sort()).toEqual(
      [
        [a.job.id, "reassigned"],
        [b.job.id, "reassigned"],
      ].sort(),
    );

    const row = await userRow(ids.users.editor1);
    expect(row?.sessionVersion).toBe(2);
    expect(await buildContextFromDb(db, ids.users.editor1, { sessionVersion: 1 })).toBeNull();

    // jobs now held by editor2; mid-edit job keeps its status (re-attributed), assigned job stays assigned
    const jobA = await first(db.select().from(jobs).where(eq(jobs.id, a.job.id)));
    const jobB = await first(db.select().from(jobs).where(eq(jobs.id, b.job.id)));
    expect(jobA).toMatchObject({ editorId: ids.users.editor2, previousEditorId: ids.users.editor1, statusCategory: "in_progress" });
    expect(jobB).toMatchObject({ editorId: ids.users.editor2, statusCategory: "assigned" });
    // completed job untouched
    expect((await first(db.select().from(jobs).where(eq(jobs.id, done.job.id))))?.editorId).toBe(ids.users.editor1);

    // old assignments closed with user_deactivated
    const closed = await first(
      db
        .select()
        .from(jobAssignments)
        .where(and(eq(jobAssignments.userId, ids.users.editor1), eq(jobAssignments.jobId, a.job.id))),
    );
    expect(closed).toMatchObject({ unassignReason: "user_deactivated", unassignedByUserId: ids.users.coAdmin });

    // running timer closed with auto_deactivated
    const session = await first(db.select().from(workSessions).where(eq(workSessions.userId, ids.users.editor1)));
    expect(session).toMatchObject({ endReason: "auto_deactivated", endedAt: "2026-10-08T01:00:00.000Z" });

    const [ev] = await eventsOf("user.deactivated");
    expect(ev.metadata).toMatchObject({ targetUserId: ids.users.editor1, reassignTo: ids.users.editor2 });
    expect((ev.metadata as { openJobs: unknown[] }).openJobs).toHaveLength(2);
    expect(ev.visibility).toBe("management");
    expect(await eventsOf("user.admin_changed")).toHaveLength(0);
  });

  it("unassign sends editor-held jobs back to Ready; no option keeps them (editor unavailable)", async () => {
    const a = await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 });
    const res = await run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.editor1, unassign: true }));
    expect(res.openJobs).toEqual([{ jobId: a.job.id, jobNumber: a.job.jobNumber, role: "editor", action: "unassigned" }]);
    expect(await first(db.select().from(jobs).where(eq(jobs.id, a.job.id)))).toMatchObject({ editorId: null, statusCategory: "ready" });

    const b = await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor2 });
    const kept = await run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.editor2 }));
    expect(kept.openJobs[0]).toMatchObject({ jobId: b.job.id, action: "kept" });
    expect((await first(db.select().from(jobs).where(eq(jobs.id, b.job.id))))?.editorId).toBe(ids.users.editor2);
    const open = await first(
      db
        .select()
        .from(jobAssignments)
        .where(and(eq(jobAssignments.jobId, b.job.id), eq(jobAssignments.role, "editor"), isNull(jobAssignments.unassignedAt))),
    );
    expect(open?.userId).toBe(ids.users.editor2);
  });

  it("guards: self, the primary owner, non-admin actors, bad reassign target, already inactive", async () => {
    await expect(run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.owner }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.coAdmin, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.coAdmin }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.coAdmin, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.owner }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.lead, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.editor1 }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.photographer1, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.editor1 }))).rejects.toThrow(ForbiddenError);
    await expect(
      run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.editor1, reassignTo: ids.users.photographer1 })),
    ).rejects.toThrow(/active editor/);
    await expect(
      run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.editor1, reassignTo: ids.users.client })),
    ).rejects.toThrow(/active editor/);
    await expect(
      run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.editor1, reassignTo: ids.users.inactiveEditor })),
    ).rejects.toThrow(/active editor/);
    await expect(run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.inactiveEditor }))).rejects.toThrow(/already deactivated/);
    await expect(
      run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.editor1, reassignTo: ids.users.editor2, unassign: true })),
    ).rejects.toThrow(ValidationError);
    // nothing was written by the failed attempts
    expect(await eventsOf("user.deactivated")).toHaveLength(0);
    expect((await userRow(ids.users.editor1))?.isActive).toBe(true);
  });

  it("deactivating an admin clears admin in the same transaction; reactivation returns a team member", async () => {
    const res = await run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.coAdmin, expectedVersion: 1 }));
    expect(res.user).toMatchObject({ isActive: false, isAdmin: false });
    const [deactivated] = await eventsOf("user.deactivated");
    expect(deactivated.metadata).toMatchObject({ adminCleared: true });
    const [admin] = await eventsOf("user.admin_changed");
    expect(admin).toMatchObject({ entityId: ids.users.coAdmin, previousValue: { isAdmin: true }, newValue: { isAdmin: false } });
    expect(admin.metadata).toMatchObject({ reason: "deactivated" });

    const back = await run(ids.users.owner, (tx, ctx) => reactivateUser(tx, ctx, { userId: ids.users.coAdmin }));
    expect(back).toMatchObject({ isActive: true, isAdmin: false });
    expect(await contextFor(db, ids.users.coAdmin)).toMatchObject({ isAdmin: false, canViewAnalytics: false, canCreateJobs: true });
    // admin comes back only through Make admin
    await run(ids.users.owner, (tx, ctx) => setAdmin(tx, ctx, { userId: ids.users.coAdmin, isAdmin: true }));
    expect((await contextFor(db, ids.users.coAdmin)).isAdmin).toBe(true);
  });

  it("client users can be deactivated (portal access ends) and reactivated", async () => {
    const res = await run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.client }));
    expect(res).toMatchObject({ user: { isActive: false }, openJobs: [] });
    expect(await buildContextFromDb(db, ids.users.client)).toBeNull();
    await run(ids.users.owner, (tx, ctx) => reactivateUser(tx, ctx, { userId: ids.users.client }));
    expect((await contextFor(db, ids.users.client)).clientId).toBe(ids.clientId);
  });

  it("a whole deactivation rolls back if one reassignment fails", async () => {
    await insertJobFixture(db, ids, { statusKey: "in_progress", editorId: ids.users.editor1 });
    const other = await seedMinimalOrg(db, { slug: "other" });
    await expect(run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.editor1, reassignTo: other.users.editor1 }))).rejects.toThrow(
      NotFoundError,
    );
    expect(await userRow(ids.users.editor1)).toMatchObject({ isActive: true, sessionVersion: 1 });
  });

  it("reactivate restores access", async () => {
    await run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: ids.users.editor2 }));
    await expect(run(ids.users.owner, (tx, ctx) => reactivateUser(tx, ctx, { userId: ids.users.editor1 }))).rejects.toThrow(/already active/);
    await expect(run(ids.users.lead, (tx, ctx) => reactivateUser(tx, ctx, { userId: ids.users.editor2 }))).rejects.toThrow(ForbiddenError);
    const back = await run(ids.users.coAdmin, (tx, ctx) => reactivateUser(tx, ctx, { userId: ids.users.editor2 }));
    expect(back).toMatchObject({ isActive: true, deactivatedAt: null });
    expect((await contextFor(db, ids.users.editor2)).isActive).toBe(true);
    expect(await eventsOf("user.reactivated")).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */

describe("resetPassword / capacity", () => {
  it("resets with a new temp password and revokes sessions", async () => {
    const res = await run(ids.users.coAdmin, (tx, ctx) => resetPassword(tx, ctx, { userId: ids.users.editor1 }, secret));
    expect(compareSync(res.tempPassword, (await userRow(ids.users.editor1))?.passwordHash ?? "")).toBe(true);
    expect((await userRow(ids.users.editor1))?.sessionVersion).toBe(2);
    const [ev] = await eventsOf("user.password_changed");
    expect(ev.summary).toBe("reset the password for Eve Editor");
    expect(JSON.stringify(ev)).not.toContain(secret.passwordHash);

    await expect(run(ids.users.coAdmin, (tx, ctx) => resetPassword(tx, ctx, { userId: ids.users.owner }, secret))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.lead, (tx, ctx) => resetPassword(tx, ctx, { userId: ids.users.editor1 }, secret))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.editor2, (tx, ctx) => resetPassword(tx, ctx, { userId: ids.users.photographer1 }, secret))).rejects.toThrow(ForbiddenError);
    expect((await run(ids.users.editor2, (tx, ctx) => resetPassword(tx, ctx, { userId: ids.users.editor2 }, secret))).userId).toBe(ids.users.editor2);
    expect((await run(ids.users.owner, (tx, ctx) => resetPassword(tx, ctx, { userId: ids.users.owner }, secret))).userId).toBe(ids.users.owner);
    // admins reset client users (portal accounts); clients reset only themselves
    expect((await run(ids.users.owner, (tx, ctx) => resetPassword(tx, ctx, { userId: ids.users.client }, secret))).userId).toBe(ids.users.client);
    await expect(run(ids.users.client2, (tx, ctx) => resetPassword(tx, ctx, { userId: ids.users.client }, secret))).rejects.toThrow(ForbiddenError);
  });

  it("capacity is admin-only, audited, and staff-only", async () => {
    const u = await run(ids.users.coAdmin, (tx, ctx) => setCapacity(tx, ctx, { userId: ids.users.editor1, capacityHoursPerWeek: 32 }));
    expect(u.capacityHoursPerWeek).toBe(32);
    expect((await eventsOf("user.capacity_changed"))[0].summary).toBe("changed Eve Editor’s capacity from the default to 32 h/week");
    await expect(run(ids.users.editor1, (tx, ctx) => setCapacity(tx, ctx, { userId: ids.users.editor1, capacityHoursPerWeek: 60 }))).rejects.toThrow(
      ForbiddenError,
    );
    await expect(run(ids.users.lead, (tx, ctx) => setCapacity(tx, ctx, { userId: ids.users.editor1, capacityHoursPerWeek: 60 }))).rejects.toThrow(
      ForbiddenError,
    );
    expect(reason(await run(ids.users.owner, (tx, ctx) => setCapacity(tx, ctx, { userId: ids.users.client, capacityHoursPerWeek: 5 })).catch((e: unknown) => e))).toBe(
      "not_staff",
    );
  });
});

/* ------------------------------------------------------------------ */

describe("client portal users", () => {
  it("lists a client's portal accounts for admins only; foreign clients 404", async () => {
    const extra = await run(ids.users.owner, (tx, ctx) =>
      inviteUser(tx, ctx, { email: "agent@harbour.test", name: "Aaron Agent", role: "client", clientId: ids.clientId }, secret),
    );
    await run(ids.users.owner, (tx, ctx) => deactivateUser(tx, ctx, { userId: extra.user.id }));
    const list = await listClientPortalUsers(db, await contextFor(db, ids.users.coAdmin), { clientId: ids.clientId });
    expect(list.map((u) => [u.id, u.isActive])).toEqual([
      [ids.users.client, true],
      [extra.user.id, false],
    ]);
    expect(list[0]).toEqual(expect.objectContaining({ name: "Cleo Client", email: ids.emails.client, lastLoginAt: null }));
    expect(list[0]).not.toHaveProperty("passwordHash");
    expect((await listClientPortalUsers(db, await contextFor(db, ids.users.owner), { clientId: ids.clientId2 })).map((u) => u.id)).toEqual([ids.users.client2]);

    await expect(listClientPortalUsers(db, await contextFor(db, ids.users.lead), { clientId: ids.clientId })).rejects.toThrow(ForbiddenError);
    await expect(listClientPortalUsers(db, await contextFor(db, ids.users.editor1), { clientId: ids.clientId })).rejects.toThrow(ForbiddenError);
    await expect(listClientPortalUsers(db, await contextFor(db, ids.users.client), { clientId: ids.clientId })).rejects.toThrow(ForbiddenError);
    const other = await seedMinimalOrg(db, { slug: "other" });
    await expect(listClientPortalUsers(db, await contextFor(db, ids.users.owner), { clientId: other.clientId })).rejects.toThrow(NotFoundError);
  });

  it("users.client_id is immutable (trigger) and must be a client of the same organisation", async () => {
    expect(await dbRejection(db.update(users).set({ clientId: ids.clientId2 }).where(eq(users.id, ids.users.client)))).toMatch(
      /a client user cannot be moved to another client/,
    );
    const other = await seedMinimalOrg(db, { slug: "other" });
    expect(
      await dbRejection(
        db.insert(users).values({
          organisationId: ids.organisationId,
          email: "x@foreign.test",
          passwordHash: testPasswordHash(),
          name: "X",
          role: "client",
          clientId: other.clientId,
        }),
      ),
    ).toMatch(/client users must belong to a client of their organisation/);
  });

  it("portal off signs client users out at their next request (context null), without touching the account", async () => {
    await db.update(clients).set({ portalEnabled: false }).where(eq(clients.id, ids.clientId));
    expect(await buildContextFromDb(db, ids.users.client)).toBeNull();
    expect(await userRow(ids.users.client)).toMatchObject({ isActive: true, sessionVersion: 1 });
  });
});

/* ------------------------------------------------------------------ */

describe("anonymiseUser", () => {
  it("admin-only, target must be deactivated; rewrites PII and blocks login", async () => {
    await expect(run(ids.users.owner, (tx, ctx) => anonymiseUser(tx, ctx, { userId: ids.users.editor1 }))).rejects.toThrow(/Deactivate/);
    await expect(run(ids.users.lead, (tx, ctx) => anonymiseUser(tx, ctx, { userId: ids.users.inactiveEditor }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.editor1, (tx, ctx) => anonymiseUser(tx, ctx, { userId: ids.users.inactiveEditor }))).rejects.toThrow(ForbiddenError);

    const before = await userRow(ids.users.inactiveEditor);
    const res = await run(ids.users.owner, (tx, ctx) => anonymiseUser(tx, ctx, { userId: ids.users.inactiveEditor }));
    expect(res).toMatchObject({
      name: "Former team member",
      email: `anon-${ids.users.inactiveEditor}@invalid`,
      avatarColour: "#94a3b8",
      anonymisedAt: "2026-10-08T00:00:00.000Z",
    });
    const after = await userRow(ids.users.inactiveEditor);
    expect(after?.passwordHash).not.toBe(before?.passwordHash);
    expect(compareSync("Password123!", after?.passwordHash ?? "")).toBe(false);

    const [ev] = await eventsOf("user.anonymised");
    expect(JSON.stringify([ev.previousValue, ev.newValue, ev.metadata])).not.toContain("Iris");
    await expect(run(ids.users.owner, (tx, ctx) => anonymiseUser(tx, ctx, { userId: ids.users.inactiveEditor }))).rejects.toThrow(/already/);
    await expect(run(ids.users.owner, (tx, ctx) => reactivateUser(tx, ctx, { userId: ids.users.inactiveEditor }))).rejects.toThrow(/anonymised/);
  });
});

/* ------------------------------------------------------------------ */

describe("notification preferences", () => {
  it("toggles optional types, keeps mandatory ones on, audits changes", async () => {
    const prefs = await run(ids.users.editor1, (tx, ctx) => setNotificationPrefs(tx, ctx, { prefs: { comment_added: false, work_approved: true } }));
    expect(prefs.find((p) => p.type === "comment_added")?.enabled).toBe(false);
    expect(prefs.find((p) => p.type === "mentioned")).toMatchObject({ mandatory: true, enabled: true });
    expect(await db.select().from(userNotificationPrefs)).toHaveLength(1);
    const [ev] = await eventsOf("user.notification_prefs_changed");
    expect(ev).toMatchObject({ previousValue: { comment_added: true }, newValue: { comment_added: false } });

    // re-enable upserts the same row
    await run(ids.users.editor1, (tx, ctx) => setNotificationPrefs(tx, ctx, { prefs: { comment_added: true } }));
    expect(await db.select().from(userNotificationPrefs)).toHaveLength(1);
    expect((await getNotificationPrefs(db, await contextFor(db, ids.users.editor1))).find((p) => p.type === "comment_added")?.enabled).toBe(true);

    await expect(run(ids.users.editor1, (tx, ctx) => setNotificationPrefs(tx, ctx, { prefs: { mentioned: false } }))).rejects.toThrow(/cannot be turned off/);
    await expect(
      run(ids.users.owner, (tx, ctx) => setNotificationPrefs(tx, ctx, { userId: ids.users.editor1, prefs: { comment_added: false } })),
    ).rejects.toThrow(ForbiddenError);
    await expect(getNotificationPrefs(db, await contextFor(db, ids.users.owner), ids.users.editor1)).rejects.toThrow(ForbiddenError);
  });

  it("staff see no client types; client users see only the three client types (§6.2)", async () => {
    const staff = await getNotificationPrefs(db, await contextFor(db, ids.users.owner));
    expect(staff.some((p) => (CLIENT_NOTIFICATION_TYPES as readonly string[]).includes(p.type))).toBe(false);
    await expect(run(ids.users.owner, (tx, ctx) => setNotificationPrefs(tx, ctx, { prefs: { client_work_shared: false } }))).rejects.toThrow(/not available/);

    const client = await getNotificationPrefs(db, await contextFor(db, ids.users.client));
    expect(client.map((p) => p.type)).toEqual([...CLIENT_NOTIFICATION_TYPES]);
    const after = await run(ids.users.client, (tx, ctx) => setNotificationPrefs(tx, ctx, { prefs: { client_work_shared: false } }));
    expect(after.find((p) => p.type === "client_work_shared")?.enabled).toBe(false);
    await expect(run(ids.users.client, (tx, ctx) => setNotificationPrefs(tx, ctx, { prefs: { comment_added: false } }))).rejects.toThrow(/not available/);
  });
});
