import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first, type Tx } from "@/db/index";
import { activityEvents, teamMemberships, teams } from "@/db/schema";
import { contextFor, dbRejection, fakeClock, makeTestDb, seedMinimalOrg, type SeedIds, type TestDb } from "@/db/test-db";
import type { AuthContext } from "@/lib/types";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { buildContextFromDb } from "@/server/auth/session";
import { withTx } from "./_shared";
import { addMember, archiveTeam, createTeam, removeMember, teamMemberIds, updateTeam } from "./teams";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

async function run<T>(userId: string, fn: (tx: Tx, ctx: AuthContext) => Promise<T> | T): Promise<T> {
  const ctx = await contextFor(db, userId);
  return withTx((tx) => fn(tx, ctx), { db });
}

async function teamEvents(teamId: string) {
  return await db.select().from(activityEvents).where(eq(activityEvents.entityId, teamId)).orderBy(activityEvents.rowid);
}

describe("teams", () => {
  it("creates a team with members (lead included) and management-only events", async () => {
    const { team, memberIds } = await run(ids.users.manager, (tx, ctx) =>
      createTeam(tx, ctx, { name: "Weddings", leadUserId: ids.users.photographer1, memberIds: [ids.users.editor1] }),
    );
    expect(memberIds.sort()).toEqual([ids.users.editor1, ids.users.photographer1].sort());
    expect((await teamMemberIds(db, team.id)).sort()).toEqual(memberIds.sort());
    const events = await teamEvents(team.id);
    expect(events.map((e) => e.eventType)).toEqual(["team.created", "team.member_added", "team.member_added"]);
    expect(events.every((e) => e.visibility === "management")).toBe(true);
    expect(events[1].summary).toMatch(/added .+ to team/);
  });

  it("only owners/managers manage teams", async () => {
    await expect(run(ids.users.photographer1, (tx, ctx) => createTeam(tx, ctx, { name: "X" }))).rejects.toThrow(ForbiddenError);
    await expect(run(ids.users.editor1, (tx, ctx) => createTeam(tx, ctx, { name: "X" }))).rejects.toThrow(ForbiddenError);
  });

  it("rejects duplicate names (case-insensitive), inactive and foreign users", async () => {
    await run(ids.users.owner, (tx, ctx) => createTeam(tx, ctx, { name: "Commercial" }));
    await expect(run(ids.users.owner, (tx, ctx) => createTeam(tx, ctx, { name: "commercial" }))).rejects.toThrow(ValidationError);
    await expect(run(ids.users.owner, (tx, ctx) => createTeam(tx, ctx, { name: "B", memberIds: [ids.users.inactiveEditor] }))).rejects.toThrow(/deactivated/);
    const other = await seedMinimalOrg(db, { slug: "other" });
    await expect(run(ids.users.owner, (tx, ctx) => createTeam(tx, ctx, { name: "C", memberIds: [other.users.editor1] }))).rejects.toThrow(NotFoundError);
  });

  it("membership is a ledger: remove fills left_at once, re-adding inserts a new row", async () => {
    const { team } = await run(ids.users.manager, (tx, ctx) => createTeam(tx, ctx, { name: "Real Estate" }));
    const m1 = await run(ids.users.manager, (tx, ctx) => addMember(tx, ctx, { teamId: team.id, userId: ids.users.editor2 }));
    await expect(run(ids.users.manager, (tx, ctx) => addMember(tx, ctx, { teamId: team.id, userId: ids.users.editor2 }))).rejects.toThrow(/already/);

    fakeClock.advanceHours(1);
    const left = await run(ids.users.manager, (tx, ctx) => removeMember(tx, ctx, { teamId: team.id, userId: ids.users.editor2 }));
    expect(left).toMatchObject({ id: m1.id, leftAt: "2026-10-08T01:00:00.000Z", removedByUserId: ids.users.manager });
    await expect(run(ids.users.manager, (tx, ctx) => removeMember(tx, ctx, { teamId: team.id, userId: ids.users.editor2 }))).rejects.toThrow(/not a member/);

    const m2 = await run(ids.users.manager, (tx, ctx) => addMember(tx, ctx, { teamId: team.id, userId: ids.users.editor2 }));
    expect(m2.id).not.toBe(m1.id);
    const rows = await db.select().from(teamMemberships).where(eq(teamMemberships.teamId, team.id));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.leftAt === null)).toHaveLength(1);
    // DB guard: a closed membership can never be reopened
    expect(await dbRejection(db.update(teamMemberships).set({ leftAt: null }).where(eq(teamMemberships.id, m1.id)))).toMatch(/immutable/);
  });

  it("membership changes the actor's teamUserIds (visibility input)", async () => {
    const { team } = await run(ids.users.manager, (tx, ctx) => createTeam(tx, ctx, { name: "Crew", memberIds: [ids.users.photographer1, ids.users.editor1] }));
    expect((await buildContextFromDb(db, ids.users.photographer1))?.teamUserIds.has(ids.users.editor1)).toBe(true);
    await run(ids.users.manager, (tx, ctx) => removeMember(tx, ctx, { teamId: team.id, userId: ids.users.editor1 }));
    expect((await buildContextFromDb(db, ids.users.photographer1))?.teamUserIds.has(ids.users.editor1)).toBe(false);
  });

  it("removing the lead clears lead_user_id; a new lead joins automatically", async () => {
    const { team } = await run(ids.users.manager, (tx, ctx) => createTeam(tx, ctx, { name: "Video", leadUserId: ids.users.editor1 }));
    await run(ids.users.manager, (tx, ctx) => removeMember(tx, ctx, { teamId: team.id, userId: ids.users.editor1 }));
    expect((await first(db.select().from(teams).where(eq(teams.id, team.id))))?.leadUserId).toBeNull();

    const fresh = await first(db.select().from(teams).where(eq(teams.id, team.id)));
    const updated = await run(ids.users.manager, (tx, ctx) =>
      updateTeam(tx, ctx, { teamId: team.id, leadUserId: ids.users.photographer2, expectedVersion: fresh?.version }),
    );
    expect(updated.leadUserId).toBe(ids.users.photographer2);
    const open = await first(
      db
        .select()
        .from(teamMemberships)
        .where(and(eq(teamMemberships.teamId, team.id), eq(teamMemberships.userId, ids.users.photographer2), isNull(teamMemberships.leftAt))),
    );
    expect(open).toBeDefined();
  });

  it("archived teams cannot be edited or receive members", async () => {
    const { team } = await run(ids.users.owner, (tx, ctx) => createTeam(tx, ctx, { name: "Old" }));
    const archived = await run(ids.users.owner, (tx, ctx) => archiveTeam(tx, ctx, { teamId: team.id, expectedVersion: 1 }));
    expect(archived.archivedAt).not.toBeNull();
    await expect(run(ids.users.owner, (tx, ctx) => addMember(tx, ctx, { teamId: team.id, userId: ids.users.editor1 }))).rejects.toThrow(/archived/);
    await expect(run(ids.users.owner, (tx, ctx) => updateTeam(tx, ctx, { teamId: team.id, name: "New" }))).rejects.toThrow(/archived/);
    await expect(run(ids.users.owner, (tx, ctx) => archiveTeam(tx, ctx, { teamId: team.id }))).rejects.toThrow(/already/);
  });
});
