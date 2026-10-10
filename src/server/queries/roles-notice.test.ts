import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityEvents, organisationSettings, users } from "@/db/schema";
import { contextFor, fakeClock, makeTestDb, seedMinimalOrg, setUserFlags, type SeedIds, type TestDb } from "@/db/test-db";
import { ForbiddenError } from "@/server/errors";
import { ROLES_V2_MIGRATION, getRolesNotice } from "./roles-notice";

const NOW = "2026-10-08T00:00:00.000Z";
let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set(NOW);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db, { at: "2026-08-01T00:00:00.000Z" });
});

afterEach(() => fakeClock.reset());

/** The events 0003 writes (docs/ROLES.md §1.3 a): one per former manager + one for editors_see_team_jobs. */
async function insertMigrationEvents(opts: { managers: string[]; editors?: string[] }): Promise<void> {
  let n = 0;
  for (const id of opts.managers) {
    await db.insert(activityEvents).values({
      id: `mig${n++}`,
      organisationId: ids.organisationId,
      entityType: "user",
      entityId: id,
      eventType: "user.role_changed",
      action: "updated",
      metadata: { cause: "migration", migration: ROLES_V2_MIGRATION, targetUserId: id, formerRole: "manager" },
      summary: "Role changed from Manager to Photographer (team member)",
      visibility: "management",
      createdAt: NOW,
    });
  }
  if (opts.editors) {
    await db.insert(activityEvents).values({
      id: `mig${n++}`,
      organisationId: ids.organisationId,
      entityType: "settings",
      entityId: ids.organisationId,
      eventType: "settings.updated",
      action: "updated",
      metadata: { cause: "migration", migration: ROLES_V2_MIGRATION, editorIds: opts.editors },
      summary: "Editors no longer see their teammates' jobs automatically",
      visibility: "management",
      createdAt: NOW,
    });
  }
}

describe("getRolesNotice (docs/ROLES.md §1.5)", () => {
  it("is absent on an organisation that never ran the migration", async () => {
    expect(await getRolesNotice(db, await contextFor(db, ids.users.owner))).toBeNull();
  });

  it("lists active non-admin former managers and the recorded editors", async () => {
    await insertMigrationEvents({ managers: [ids.users.lead, ids.users.coAdmin], editors: [ids.users.editor1, ids.users.inactiveEditor] });
    const notice = await getRolesNotice(db, await contextFor(db, ids.users.owner));
    expect(notice).not.toBeNull();
    // coAdmin is already an admin → not offered; both still count as former managers.
    expect(notice?.exManagerCount).toBe(2);
    expect(notice?.exManagers.map((p) => p.id)).toEqual([ids.users.lead]);
    // The deactivated editor is skipped.
    expect(notice?.teamJobEditors).toEqual([expect.objectContaining({ id: ids.users.editor1, canViewTeamJobs: false })]);
  });

  it("reflects switches turned on since", async () => {
    await insertMigrationEvents({ managers: [], editors: [ids.users.editor1] });
    await setUserFlags(db, ids.users.editor1, { canViewTeamJobs: true });
    const notice = await getRolesNotice(db, await contextFor(db, ids.users.owner));
    expect(notice?.teamJobEditors[0]).toMatchObject({ id: ids.users.editor1, canViewTeamJobs: true });
  });

  it("disappears once dismissed", async () => {
    await insertMigrationEvents({ managers: [ids.users.lead] });
    await db.update(organisationSettings).set({ rolesV2NoticeDismissedAt: NOW }).where(eq(organisationSettings.organisationId, ids.organisationId));
    expect(await getRolesNotice(db, await contextFor(db, ids.users.owner))).toBeNull();
  });

  it("skips former managers who were deactivated", async () => {
    await insertMigrationEvents({ managers: [ids.users.lead] });
    await db.update(users).set({ isActive: false }).where(eq(users.id, ids.users.lead));
    const notice = await getRolesNotice(db, await contextFor(db, ids.users.owner));
    expect(notice?.exManagers).toEqual([]);
    expect(notice?.exManagerCount).toBe(1);
  });

  it("is admin-only", async () => {
    await insertMigrationEvents({ managers: [ids.users.lead] });
    for (const key of ["lead", "photographer1", "editor1"] as const) {
      await expect(getRolesNotice(db, await contextFor(db, ids.users[key]))).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});
