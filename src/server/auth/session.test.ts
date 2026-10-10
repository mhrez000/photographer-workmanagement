import { eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clients, organisationSettings, teamMemberships, users } from "@/db/schema";
import { addTeamFixture, fakeClock, inviteDefaultsMember, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import { buildContextFromDb, effectiveFlags, loadTeamUserIds, signSessionToken, systemContext, verifySessionToken } from "./session";

describe("session tokens", () => {
  it("round-trips { sub, sv, k } (a missing kind claim reads as staff)", async () => {
    const token = await signSessionToken({ sub: "user-1", sv: 3 });
    expect(await verifySessionToken(token)).toEqual({ sub: "user-1", sv: 3, k: "staff" });
    const client = await signSessionToken({ sub: "user-2", sv: 1, k: "client" });
    expect(await verifySessionToken(client)).toEqual({ sub: "user-2", sv: 1, k: "client" });
  });

  it("rejects tampered, foreign-key and malformed tokens", async () => {
    const token = await signSessionToken({ sub: "user-1", sv: 1 });
    const [h, p, s] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ sub: "owner", sv: 1 })).toString("base64url");
    expect(await verifySessionToken(`${h}.${forgedPayload}.${s}`)).toBeNull();
    expect(await verifySessionToken(`${h}.${p}.${s}x`)).toBeNull();
    const otherKey = await new SignJWT({ sv: 1 })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-1")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("another-secret-another-secret-another-secret"));
    expect(await verifySessionToken(otherKey)).toBeNull();
    expect(await verifySessionToken("not-a-jwt")).toBeNull();
    expect(await verifySessionToken(undefined)).toBeNull();
  });

  it("rejects expired tokens", async () => {
    const expired = await new SignJWT({ sv: 1 })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-1")
      .setIssuedAt(1_000)
      .setExpirationTime(2_000)
      .sign(new TextEncoder().encode(process.env.SESSION_SECRET ?? ""));
    expect(await verifySessionToken(expired)).toBeNull();
  });
});

describe("buildContextFromDb", () => {
  let db: TestDb;
  let ids: SeedIds;

  beforeEach(async () => {
    fakeClock.set("2026-10-08T00:00:00.000Z");
    db = await makeTestDb();
    ids = await seedMinimalOrg(db, { settings: { timeTrackingEnabled: true } });
  });
  afterEach(() => fakeClock.reset());

  it("builds a context for an active user from the fresh row + org settings", async () => {
    const ctx = await buildContextFromDb(db, ids.users.coAdmin, { sessionVersion: 1, requestId: "req-1" });
    expect(ctx).not.toBeNull();
    expect(ctx).toMatchObject({
      userId: ids.users.coAdmin,
      organisationId: ids.organisationId,
      role: "photographer",
      isAdmin: true,
      isPrimaryOwner: false,
      isActive: true,
      isSystem: false,
      requestId: "req-1",
      // admin ⇒ every member switch, whatever the raw columns say
      canViewAnalytics: true,
      canViewAllJobs: true,
      canReviewSubmissions: true,
      canViewTeamJobs: false,
      clientId: null,
      clientFeedbackEnabled: false,
    });
    expect(ctx?.settings).toEqual({ timezone: "Australia/Sydney", timeTrackingEnabled: true, automationsEnabled: true, auditNotifications: false });
    expect(ctx?.now()).toBe("2026-10-08T00:00:00.000Z");
    fakeClock.advanceMinutes(1);
    expect(ctx?.now()).toBe("2026-10-08T00:01:00.000Z");
  });

  it("returns null for inactive, anonymised and unknown users", async () => {
    expect(await buildContextFromDb(db, ids.users.inactiveEditor)).toBeNull();
    expect(await buildContextFromDb(db, "nope")).toBeNull();
    await db.update(users).set({ anonymisedAt: fakeClock.now() }).where(eq(users.id, ids.users.editor2));
    expect(await buildContextFromDb(db, ids.users.editor2)).toBeNull();
  });

  it("returns null when the session version is stale (revocation)", async () => {
    expect(await buildContextFromDb(db, ids.users.editor1, { sessionVersion: 1 })).not.toBeNull();
    await db.update(users).set({ sessionVersion: sql`${users.sessionVersion} + 1` }).where(eq(users.id, ids.users.editor1));
    expect(await buildContextFromDb(db, ids.users.editor1, { sessionVersion: 1 })).toBeNull();
    expect(await buildContextFromDb(db, ids.users.editor1, { sessionVersion: 2 })).not.toBeNull();
  });

  it("re-reads role/flags on every build (no stale permissions)", async () => {
    expect((await buildContextFromDb(db, ids.users.photographer1))?.canViewAnalytics).toBe(false);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, ids.users.photographer1));
    const ctx = await buildContextFromDb(db, ids.users.photographer1);
    expect(ctx?.isAdmin).toBe(true);
    expect(ctx?.canViewAnalytics).toBe(true);
    await db.update(users).set({ isAdmin: false, canViewAnalytics: true }).where(eq(users.id, ids.users.photographer1));
    expect((await buildContextFromDb(db, ids.users.photographer1))).toMatchObject({ isAdmin: false, canViewAnalytics: true, canViewAllJobs: false });
    await db.update(organisationSettings).set({ timezone: "Europe/London" });
    expect((await buildContextFromDb(db, ids.users.photographer1))?.settings.timezone).toBe("Europe/London");
  });

  it("marks the primary owner and computes effective switches per persona", async () => {
    const owner = await buildContextFromDb(db, ids.users.owner);
    expect(owner).toMatchObject({ isAdmin: true, isPrimaryOwner: true });
    const lead = await buildContextFromDb(db, ids.users.lead);
    expect(lead).toMatchObject({ isAdmin: false, canViewAllJobs: true, canViewTeamWorkloads: true, canViewAnalytics: true, canViewTeamJobs: false });
    const p1 = await buildContextFromDb(db, ids.users.photographer1);
    expect(p1).toMatchObject({ canCreateJobs: true, canAssignEditors: true, canReviewSubmissions: true, canViewAllJobs: false, canViewAnalytics: false });
    const fresh = await buildContextFromDb(db, await inviteDefaultsMember(db, ids));
    expect(fresh).toMatchObject({ canCreateJobs: true, canAssignEditors: true, canReviewSubmissions: false, canViewAllJobs: false });
    // a member switch on an editor row is ignored; the editor switch only counts for editors
    await db.update(users).set({ canViewAllJobs: true, canReviewSubmissions: true, canViewTeamJobs: true }).where(eq(users.id, ids.users.editor1));
    expect(await buildContextFromDb(db, ids.users.editor1)).toMatchObject({ canViewAllJobs: false, canReviewSubmissions: false, canViewTeamJobs: true, canCreateJobs: true });
    await db.update(users).set({ canViewTeamJobs: true }).where(eq(users.id, ids.users.photographer1));
    expect((await buildContextFromDb(db, ids.users.photographer1))?.canViewTeamJobs).toBe(false);
  });

  it("effectiveFlags: clients have no switches", () => {
    const none = effectiveFlags({
      role: "client",
      isAdmin: false,
      canCreateJobs: true,
      canViewAllJobs: true,
      canAssignEditors: true,
      canReviewSubmissions: true,
      canViewTeamWorkloads: true,
      canViewAnalytics: true,
      canViewTeamJobs: true,
    });
    expect(Object.values(none).every((v) => v === false)).toBe(true);
  });

  it("client users: context carries the client; none while the portal is off or the client is archived", async () => {
    const ctx = await buildContextFromDb(db, ids.users.client);
    expect(ctx).toMatchObject({ role: "client", isAdmin: false, clientId: ids.clientId, clientFeedbackEnabled: true, canCreateJobs: false });
    expect(ctx?.teamUserIds.size).toBe(0);
    expect((await buildContextFromDb(db, ids.users.client2))?.clientFeedbackEnabled).toBe(false);
    await db.update(clients).set({ portalEnabled: false }).where(eq(clients.id, ids.clientId));
    expect(await buildContextFromDb(db, ids.users.client)).toBeNull();
    await db.update(clients).set({ portalEnabled: true, archivedAt: fakeClock.now() }).where(eq(clients.id, ids.clientId));
    expect(await buildContextFromDb(db, ids.users.client)).toBeNull();
    expect(await buildContextFromDb(db, ids.users.client2)).not.toBeNull();
  });

  describe("teamUserIds", () => {
    it("contains users sharing an active membership in a non-archived team, never the user", async () => {
      await addTeamFixture(db, ids, { name: "Weddings", memberIds: [ids.users.editor1, ids.users.photographer1, ids.users.photographer2] });
      await addTeamFixture(db, ids, { name: "Commercial", memberIds: [ids.users.editor1, ids.users.editor2] });
      const ctx = await buildContextFromDb(db, ids.users.editor1);
      expect([...(ctx?.teamUserIds ?? [])].sort()).toEqual([ids.users.editor2, ids.users.photographer1, ids.users.photographer2].sort());
      expect(ctx?.teamUserIds.has(ids.users.editor1)).toBe(false);
    });

    it("ignores archived teams and memberships that ended (either side)", async () => {
      await addTeamFixture(db, ids, { name: "Old crew", archived: true, memberIds: [ids.users.editor1, ids.users.photographer2] });
      const live = await addTeamFixture(db, ids, { name: "Live", memberIds: [ids.users.editor1, ids.users.photographer1, ids.users.coAdmin] });
      const [, photographerMembership] = live.membershipIds;
      await db.update(teamMemberships).set({ leftAt: fakeClock.now() }).where(eq(teamMemberships.id, photographerMembership));
      expect([...(await loadTeamUserIds(db, ids.organisationId, ids.users.editor1))]).toEqual([ids.users.coAdmin]);

      // the user themself left → no teammates at all from that team
      const [editorMembership] = live.membershipIds;
      await db.update(teamMemberships).set({ leftAt: fakeClock.now() }).where(eq(teamMemberships.id, editorMembership));
      expect((await loadTeamUserIds(db, ids.organisationId, ids.users.editor1)).size).toBe(0);
    });

    it("never crosses organisations", async () => {
      const other = await seedMinimalOrg(db, { slug: "other" });
      await addTeamFixture(db, other, { name: "X", memberIds: [other.users.editor1, other.users.photographer1] });
      expect((await loadTeamUserIds(db, ids.organisationId, other.users.editor1)).size).toBe(0);
    });
  });
});

describe("systemContext", () => {
  it("is a system actor with the org settings and the given cause", async () => {
    fakeClock.set("2026-10-08T00:00:00.000Z");
    const db = await makeTestDb();
    const ids = await seedMinimalOrg(db, { settings: { automationsEnabled: false } });
    const ctx = await systemContext(ids.organisationId, { db, requestId: "sys", automationRunId: "run-1" });
    expect(ctx).toMatchObject({
      userId: null,
      isSystem: true,
      role: "photographer",
      isAdmin: true,
      isPrimaryOwner: false,
      canViewAllJobs: true,
      clientId: null,
      cause: "automation",
      automationRunId: "run-1",
      requestId: "sys",
    });
    expect(ctx.settings.automationsEnabled).toBe(false);
    expect((await systemContext(ids.organisationId, { db })).cause).toBe("sweep");
    fakeClock.reset();
  });
});
