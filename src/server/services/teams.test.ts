import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tx } from "@/db/index";
import { activityEvents, teamMemberships, teams } from "@/db/schema";
import { contextFor, fakeClock, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import type { AuthContext } from "@/lib/types";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { buildContextFromDb } from "@/server/auth/session";
import { withTx } from "./_shared";
import { addMember, archiveTeam, createTeam, removeMember, teamMemberIds, updateTeam } from "./teams";

let db: TestDb;
let ids: SeedIds;

beforeEach(() => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = makeTestDb();
  ids = seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

function run<T>(userId: string, fn: (tx: Tx, ctx: AuthContext) => T): T {
  const ctx = contextFor(db, userId);
  return withTx((tx) => fn(tx, ctx), { db });
}

function teamEvents(teamId: string) {
  return db.select().from(activityEvents).where(eq(activityEvents.entityId, teamId)).all();
}

describe("teams", () => {
  it("creates a team with members (lead included) and management-only events", () => {
    const { team, memberIds } = run(ids.users.manager, (tx, ctx) =>
      createTeam(tx, ctx, { name: "Weddings", leadUserId: ids.users.photographer1, memberIds: [ids.users.editor1] }),
    );
    expect(memberIds.sort()).toEqual([ids.users.editor1, ids.users.photographer1].sort());
    expect(teamMemberIds(db, team.id).sort()).toEqual(memberIds.sort());
    const events = teamEvents(team.id);
    expect(events.map((e) => e.eventType)).toEqual(["team.created", "team.member_added", "team.member_added"]);
    expect(events.every((e) => e.visibility === "management")).toBe(true);
    expect(events[1].summary).toMatch(/added .+ to team/);
  });

  it("only owners/managers manage teams", () => {
    expect(() => run(ids.users.photographer1, (tx, ctx) => createTeam(tx, ctx, { name: "X" }))).toThrow(ForbiddenError);
    expect(() => run(ids.users.editor1, (tx, ctx) => createTeam(tx, ctx, { name: "X" }))).toThrow(ForbiddenError);
  });

  it("rejects duplicate names (case-insensitive), inactive and foreign users", () => {
    run(ids.users.owner, (tx, ctx) => createTeam(tx, ctx, { name: "Commercial" }));
    expect(() => run(ids.users.owner, (tx, ctx) => createTeam(tx, ctx, { name: "commercial" }))).toThrow(ValidationError);
    expect(() => run(ids.users.owner, (tx, ctx) => createTeam(tx, ctx, { name: "B", memberIds: [ids.users.inactiveEditor] }))).toThrow(/deactivated/);
    const other = seedMinimalOrg(db, { slug: "other" });
    expect(() => run(ids.users.owner, (tx, ctx) => createTeam(tx, ctx, { name: "C", memberIds: [other.users.editor1] }))).toThrow(NotFoundError);
  });

  it("membership is a ledger: remove fills left_at once, re-adding inserts a new row", () => {
    const { team } = run(ids.users.manager, (tx, ctx) => createTeam(tx, ctx, { name: "Real Estate" }));
    const m1 = run(ids.users.manager, (tx, ctx) => addMember(tx, ctx, { teamId: team.id, userId: ids.users.editor2 }));
    expect(() => run(ids.users.manager, (tx, ctx) => addMember(tx, ctx, { teamId: team.id, userId: ids.users.editor2 }))).toThrow(/already/);

    fakeClock.advanceHours(1);
    const left = run(ids.users.manager, (tx, ctx) => removeMember(tx, ctx, { teamId: team.id, userId: ids.users.editor2 }));
    expect(left).toMatchObject({ id: m1.id, leftAt: "2026-10-08T01:00:00.000Z", removedByUserId: ids.users.manager });
    expect(() => run(ids.users.manager, (tx, ctx) => removeMember(tx, ctx, { teamId: team.id, userId: ids.users.editor2 }))).toThrow(/not a member/);

    const m2 = run(ids.users.manager, (tx, ctx) => addMember(tx, ctx, { teamId: team.id, userId: ids.users.editor2 }));
    expect(m2.id).not.toBe(m1.id);
    const rows = db.select().from(teamMemberships).where(eq(teamMemberships.teamId, team.id)).all();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.leftAt === null)).toHaveLength(1);
    // DB guard: a closed membership can never be reopened
    expect(() => db.update(teamMemberships).set({ leftAt: null }).where(eq(teamMemberships.id, m1.id)).run()).toThrow(/immutable/);
  });

  it("membership changes the actor's teamUserIds (visibility input)", () => {
    const { team } = run(ids.users.manager, (tx, ctx) => createTeam(tx, ctx, { name: "Crew", memberIds: [ids.users.photographer1, ids.users.editor1] }));
    expect(buildContextFromDb(db, ids.users.photographer1)?.teamUserIds.has(ids.users.editor1)).toBe(true);
    run(ids.users.manager, (tx, ctx) => removeMember(tx, ctx, { teamId: team.id, userId: ids.users.editor1 }));
    expect(buildContextFromDb(db, ids.users.photographer1)?.teamUserIds.has(ids.users.editor1)).toBe(false);
  });

  it("removing the lead clears lead_user_id; a new lead joins automatically", () => {
    const { team } = run(ids.users.manager, (tx, ctx) => createTeam(tx, ctx, { name: "Video", leadUserId: ids.users.editor1 }));
    run(ids.users.manager, (tx, ctx) => removeMember(tx, ctx, { teamId: team.id, userId: ids.users.editor1 }));
    expect(db.select().from(teams).where(eq(teams.id, team.id)).get()?.leadUserId).toBeNull();

    const fresh = db.select().from(teams).where(eq(teams.id, team.id)).get();
    const updated = run(ids.users.manager, (tx, ctx) =>
      updateTeam(tx, ctx, { teamId: team.id, leadUserId: ids.users.photographer2, expectedVersion: fresh?.version }),
    );
    expect(updated.leadUserId).toBe(ids.users.photographer2);
    const open = db
      .select()
      .from(teamMemberships)
      .where(and(eq(teamMemberships.teamId, team.id), eq(teamMemberships.userId, ids.users.photographer2), isNull(teamMemberships.leftAt)))
      .get();
    expect(open).toBeDefined();
  });

  it("archived teams cannot be edited or receive members", () => {
    const { team } = run(ids.users.owner, (tx, ctx) => createTeam(tx, ctx, { name: "Old" }));
    const archived = run(ids.users.owner, (tx, ctx) => archiveTeam(tx, ctx, { teamId: team.id, expectedVersion: 1 }));
    expect(archived.archivedAt).not.toBeNull();
    expect(() => run(ids.users.owner, (tx, ctx) => addMember(tx, ctx, { teamId: team.id, userId: ids.users.editor1 }))).toThrow(/archived/);
    expect(() => run(ids.users.owner, (tx, ctx) => updateTeam(tx, ctx, { teamId: team.id, name: "New" }))).toThrow(/archived/);
    expect(() => run(ids.users.owner, (tx, ctx) => archiveTeam(tx, ctx, { teamId: team.id }))).toThrow(/already/);
  });
});
