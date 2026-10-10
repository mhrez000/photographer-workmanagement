/**
 * Roles v2 (docs/ROLES.md §2.3, §7.2, §8, §12.1): on a real database,
 *   - visibleJobsWhere(ctx) selects exactly the jobs where can(ctx, "job.view", ref) is true,
 *   - portalJobsWhere(ctx) selects exactly the jobs where can(ctx, "portal.view_job", ref) is true,
 *   - clients get no rows from visibleJobsWhere,
 *   - myShootsWhere(owner) = photographer_id = owner (an owner-created job for photographer02 is absent),
 *   - loadJobRef computes draftClosed / pastEditorIds / projectSharedWithClient.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jobAssignments, jobs, projects } from "@/db/schema";
import {
  contextFor,
  fakeClock,
  insertJobFixture,
  inviteDefaultsMember,
  makeTestDb,
  seedMinimalOrg,
  setUserFlags,
  type SeedIds,
  type TestDb,
} from "@/db/test-db";
import type { AuthContext } from "@/lib/types";
import { nowIso } from "@/server/clock";
import { myShootsWhere, scopedJobsWhere } from "@/server/view-scope";
import { loadJobRef, loadJobRefs } from "./job-ref";
import { can, portalJobsWhere, visibleJobsWhere } from "./permissions";

let db: TestDb;
let ids: SeedIds;
let other: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
  other = await seedMinimalOrg(db, { slug: "other" });
});
afterEach(() => fakeClock.reset());

async function names(where: ReturnType<typeof visibleJobsWhere>): Promise<string[]> {
  const rows = await db.select({ name: jobs.name }).from(jobs).where(and(where)).orderBy(asc(jobs.name));
  return rows.map((r) => r.name);
}

/** ~16 jobs covering every scope of §2.3 / §7.2. */
async function seedScopeJobs(): Promise<void> {
  const u = ids.users;
  const old = new Date(Date.parse(nowIso()) - 40 * 24 * 3600_000).toISOString();
  await insertJobFixture(db, ids, { name: "01 owner shoots", statusKey: "in_progress", photographerId: u.owner, createdByUserId: u.owner, editorId: u.editor1 });
  await insertJobFixture(db, ids, { name: "02 owner for p2", statusKey: "new", photographerId: u.photographer2, createdByUserId: u.owner });
  await insertJobFixture(db, ids, { name: "03 p1 own", statusKey: "in_progress", photographerId: u.photographer1, createdByUserId: u.photographer1, editorId: u.editor1 });
  await insertJobFixture(db, ids, { name: "04 p1 shot, owner created", statusKey: "new", photographerId: u.photographer1, createdByUserId: u.owner });
  await insertJobFixture(db, ids, { name: "05 p1 created for p2", statusKey: "new", photographerId: u.photographer2, createdByUserId: u.photographer1 });
  await insertJobFixture(db, ids, { name: "06 e1 draft for owner", statusKey: "new", photographerId: u.owner, createdByUserId: u.editor1, editorId: null });
  await insertJobFixture(db, ids, { name: "07 e1 created, e2 holds", statusKey: "in_progress", photographerId: u.owner, createdByUserId: u.editor1, editorId: u.editor2 });
  await insertJobFixture(db, ids, { name: "08 p2 + e2", statusKey: "in_progress", photographerId: u.photographer2, createdByUserId: u.photographer2, editorId: u.editor2 });
  const past = await insertJobFixture(db, ids, { name: "09 e1 past, e2 now", statusKey: "in_progress", photographerId: u.photographer2, createdByUserId: u.photographer2, editorId: u.editor2 });
  await db.insert(jobAssignments).values({
    organisationId: ids.organisationId,
    jobId: past.job.id,
    role: "editor",
    userId: u.editor1,
    assignedByUserId: u.owner,
    assignedAt: nowIso(),
    unassignedAt: nowIso(),
    unassignedByUserId: u.owner,
    unassignReason: "reassigned",
  });
  await insertJobFixture(db, ids, { name: "10 p2 no editor", statusKey: "new", photographerId: u.photographer2, createdByUserId: u.photographer2, editorId: null });
  await insertJobFixture(db, ids, { name: "11 shared delivered", statusKey: "completed", editorId: u.editor2, photographerId: u.photographer2, createdByUserId: u.photographer2, sharedWithClient: true });
  await insertJobFixture(db, ids, { name: "12 unshared", statusKey: "in_progress", editorId: u.editor2, photographerId: u.photographer2, createdByUserId: u.photographer2 });
  await insertJobFixture(db, ids, { name: "13 cancelled shared recent", statusKey: "cancelled", photographerId: u.photographer2, createdByUserId: u.photographer2, sharedWithClient: true });
  await insertJobFixture(db, ids, { name: "14 cancelled shared old", statusKey: "cancelled", photographerId: u.photographer2, createdByUserId: u.photographer2, sharedWithClient: true, at: old });
  await insertJobFixture(db, ids, { name: "15 client2 project shared", statusKey: "in_progress", editorId: u.editor2, photographerId: u.photographer2, createdByUserId: u.photographer2, projectId: ids.projectId2 });
  await db.update(projects).set({ sharedWithClient: true }).where(eq(projects.id, ids.projectId2));
  await insertJobFixture(db, other, { name: "99 foreign shared", statusKey: "completed", sharedWithClient: true });
}

async function contexts(): Promise<Record<string, AuthContext>> {
  const u = ids.users;
  const newMember = await inviteDefaultsMember(db, ids);
  const out: Record<string, AuthContext> = {
    owner: await contextFor(db, u.owner),
    coAdmin: await contextFor(db, u.coAdmin),
    lead: await contextFor(db, u.lead),
    photographer1: await contextFor(db, u.photographer1),
    photographer2: await contextFor(db, u.photographer2),
    newMember: await contextFor(db, newMember),
    editor1: await contextFor(db, u.editor1),
    editor2: await contextFor(db, u.editor2),
    client: await contextFor(db, u.client),
    client2: await contextFor(db, u.client2),
    otherOwner: await contextFor(db, other.users.owner),
    otherClient: await contextFor(db, other.users.client),
  };
  await setUserFlags(db, u.editor1, { canViewTeamJobs: true });
  out.editor1Team = await contextFor(db, u.editor1);
  await setUserFlags(db, u.editor1, { canViewTeamJobs: false });
  out.inactiveOwner = { ...out.owner, isActive: false };
  out.userless = { ...out.photographer1, userId: null };
  return out;
}

describe("SQL twins agree with the pure rules", () => {
  it("visibleJobsWhere = job.view and portalJobsWhere = portal.view_job, for every persona and switch combination", async () => {
    await seedScopeJobs();
    const all = await db.select({ id: jobs.id, name: jobs.name, organisationId: jobs.organisationId }).from(jobs);
    const refs = new Map([
      ...(await loadJobRefs(db, { organisationId: ids.organisationId }, all.map((j) => j.id))),
      ...(await loadJobRefs(db, { organisationId: other.organisationId }, all.map((j) => j.id))),
    ]);
    expect(refs.size).toBe(all.length);
    const byName = (pred: (id: string) => boolean) => all.filter((j) => pred(j.id)).map((j) => j.name).sort();

    for (const [key, ctx] of Object.entries(await contexts())) {
      const view = byName((id) => {
        const r = refs.get(id);
        return r !== undefined && can(ctx, "job.view", r.ref);
      });
      expect(await names(visibleJobsWhere(ctx)), `visible ${key}`).toEqual(view);
      const portal = byName((id) => {
        const r = refs.get(id);
        return r !== undefined && can(ctx, "portal.view_job", r.ref);
      });
      expect(await names(portalJobsWhere(ctx)), `portal ${key}`).toEqual(portal);
    }
  });

  it("pins the expected sets", async () => {
    await seedScopeJobs();
    const c = await contexts();
    const staffJobs = (await names(visibleJobsWhere(c.owner))).length;
    expect(staffJobs).toBe(15);
    expect(await names(visibleJobsWhere(c.coAdmin))).toHaveLength(15);
    expect(await names(visibleJobsWhere(c.lead))).toHaveLength(15); // ⚑all
    expect(await names(visibleJobsWhere(c.photographer1))).toEqual(["03 p1 own", "04 p1 shot, owner created", "05 p1 created for p2"]);
    expect(await names(visibleJobsWhere(c.editor1))).toEqual(["01 owner shoots", "03 p1 own", "06 e1 draft for owner", "07 e1 created, e2 holds", "09 e1 past, e2 now"]);
    // ⚑teamJobs: every job some editor holds (read-only), incl. the owner's shoots while edited; cancelled jobs have no editor
    expect(await names(visibleJobsWhere(c.editor1Team))).toEqual([
      "01 owner shoots",
      "03 p1 own",
      "06 e1 draft for owner",
      "07 e1 created, e2 holds",
      "08 p2 + e2",
      "09 e1 past, e2 now",
      "11 shared delivered",
      "12 unshared",
      "15 client2 project shared",
    ]);
    // clients: nothing through staff reads; the portal shows shared work only
    expect(await names(visibleJobsWhere(c.client))).toEqual([]);
    expect(await names(portalJobsWhere(c.client))).toEqual(["11 shared delivered", "13 cancelled shared recent"]);
    expect(await names(portalJobsWhere(c.client2))).toEqual(["15 client2 project shared"]);
    expect(await names(portalJobsWhere(c.otherClient))).toEqual(["99 foreign shared"]);
    // staff never get portal rows
    expect(await names(portalJobsWhere(c.owner))).toEqual([]);
    expect(await names(visibleJobsWhere(c.inactiveOwner))).toEqual([]);
    expect(await names(visibleJobsWhere(c.userless))).toEqual([]);
  });

  it("My shoots = photographer_id = me (an owner-created job for photographer02 is absent)", async () => {
    await seedScopeJobs();
    const c = await contexts();
    expect(await names(and(visibleJobsWhere(c.owner), myShootsWhere(c.owner)) as ReturnType<typeof visibleJobsWhere>)).toEqual([
      "01 owner shoots",
      "06 e1 draft for owner",
      "07 e1 created, e2 holds",
    ]);
    expect(await names(scopedJobsWhere(c.owner, "mine"))).not.toContain("02 owner for p2");
    expect(await names(scopedJobsWhere(c.owner, "business"))).toContain("02 owner for p2");
    expect(await names(scopedJobsWhere(c.editor1, "mine"))).toEqual([]);
  });
});

describe("loadJobRef", () => {
  it("computes draftClosed (start, removal by someone else, cancel; not the editor's own decline)", async () => {
    const u = ids.users;
    const draft = await insertJobFixture(db, ids, { statusKey: "new", photographerId: u.owner, createdByUserId: u.editor1, editorId: null });
    expect((await loadJobRef(db, ids, draft.job.id)).ref).toMatchObject({ draftClosed: false, createdByRole: "editor", pastEditorIds: [] });

    const started = await insertJobFixture(db, ids, { statusKey: "in_progress", createdByUserId: u.editor1, editorId: u.editor1 });
    expect((await loadJobRef(db, ids, started.job.id)).ref.draftClosed).toBe(true);

    const cancelled = await insertJobFixture(db, ids, { statusKey: "cancelled", createdByUserId: u.editor1, editorId: null });
    expect((await loadJobRef(db, ids, cancelled.job.id)).ref.draftClosed).toBe(true);

    const declined = await insertJobFixture(db, ids, { statusKey: "ready", createdByUserId: u.editor1, editorId: null });
    await db.insert(jobAssignments).values({
      organisationId: ids.organisationId,
      jobId: declined.job.id,
      role: "editor",
      userId: u.editor1,
      assignedByUserId: u.editor1,
      assignedAt: nowIso(),
      unassignedAt: nowIso(),
      unassignedByUserId: u.editor1,
      unassignReason: "declined",
    });
    const declinedRef = (await loadJobRef(db, ids, declined.job.id)).ref;
    expect(declinedRef.draftClosed).toBe(false);
    expect(declinedRef.pastEditorIds).toEqual([u.editor1]);

    await db.insert(jobAssignments).values({
      organisationId: ids.organisationId,
      jobId: draft.job.id,
      role: "editor",
      userId: u.editor2,
      assignedByUserId: u.owner,
      assignedAt: nowIso(),
      unassignedAt: nowIso(),
      unassignedByUserId: u.owner,
      unassignReason: "unassigned",
    });
    expect((await loadJobRef(db, ids, draft.job.id)).ref.draftClosed).toBe(true);
  });

  it("carries the sharing facts and 404s foreign ids", async () => {
    const job = await insertJobFixture(db, ids, { statusKey: "new", projectId: ids.projectId2, sharedWithClient: true });
    await db.update(projects).set({ sharedWithClient: true }).where(inArray(projects.id, [ids.projectId2]));
    expect((await loadJobRef(db, ids, job.job.id)).ref).toMatchObject({
      clientId: ids.clientId2,
      sharedWithClient: true,
      projectSharedWithClient: true,
      createdByRole: "photographer",
    });
    await expect(loadJobRef(db, other, job.job.id)).rejects.toThrow(/not found/);
  });
});
