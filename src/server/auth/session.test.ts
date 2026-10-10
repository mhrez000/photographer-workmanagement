import { eq, sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { organisationSettings, teamMemberships, users } from "@/db/schema";
import { addTeamFixture, fakeClock, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import { buildContextFromDb, loadTeamUserIds, signSessionToken, systemContext, verifySessionToken } from "./session";

describe("session tokens", () => {
  it("round-trips { sub, sv }", async () => {
    const token = await signSessionToken({ sub: "user-1", sv: 3 });
    expect(await verifySessionToken(token)).toEqual({ sub: "user-1", sv: 3 });
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
    ids = await seedMinimalOrg(db, { settings: { timeTrackingEnabled: true, editorsSeeTeamJobs: true } });
  });
  afterEach(() => fakeClock.reset());

  it("builds a context for an active user from the fresh row + org settings", async () => {
    const ctx = await buildContextFromDb(db, ids.users.manager, { sessionVersion: 1, requestId: "req-1" });
    expect(ctx).not.toBeNull();
    expect(ctx).toMatchObject({
      userId: ids.users.manager,
      organisationId: ids.organisationId,
      role: "manager",
      isActive: true,
      isSystem: false,
      requestId: "req-1",
      canViewAnalytics: false,
    });
    expect(ctx?.settings).toMatchObject({ timezone: "Australia/Sydney", timeTrackingEnabled: true, editorsSeeTeamJobs: true });
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
    await db.update(users).set({ role: "manager", canViewAnalytics: true }).where(eq(users.id, ids.users.photographer1));
    const ctx = await buildContextFromDb(db, ids.users.photographer1);
    expect(ctx?.role).toBe("manager");
    expect(ctx?.canViewAnalytics).toBe(true);
    await db.update(organisationSettings).set({ timezone: "Europe/London" });
    expect((await buildContextFromDb(db, ids.users.photographer1))?.settings.timezone).toBe("Europe/London");
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
      const live = await addTeamFixture(db, ids, { name: "Live", memberIds: [ids.users.editor1, ids.users.photographer1, ids.users.manager] });
      const [, photographerMembership] = live.membershipIds;
      await db.update(teamMemberships).set({ leftAt: fakeClock.now() }).where(eq(teamMemberships.id, photographerMembership));
      expect([...(await loadTeamUserIds(db, ids.organisationId, ids.users.editor1))]).toEqual([ids.users.manager]);

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
    expect(ctx).toMatchObject({ userId: null, isSystem: true, role: "owner", cause: "automation", automationRunId: "run-1", requestId: "sys" });
    expect(ctx.settings.automationsEnabled).toBe(false);
    expect((await systemContext(ids.organisationId, { db })).cause).toBe("sweep");
    fakeClock.reset();
  });
});
