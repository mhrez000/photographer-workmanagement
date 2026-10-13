import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first, one, type Tx } from "@/db/index";
import {
  activityEvents,
  clients,
  jobAssignments,
  jobLinks,
  jobNotes,
  jobStatusTransitions,
  jobs,
  notifications,
  organisationSettings,
  projects,
  users,
  workSessions,
} from "@/db/schema";
import {
  contextFor,
  dbRejection,
  fakeClock,
  insertJobFixture,
  inviteDefaultsMember,
  makeTestDb,
  optInAllNotifications,
  seedMinimalOrg,
  setUserFlags,
  type FixtureUserKey,
  type SeedIds,
  type TestDb,
} from "@/db/test-db";
import { verifyDerived } from "@/db/verify";
import { civilDate } from "@/lib/dates";
import type { AuthContext, Job } from "@/lib/types";
import { deadlineToIso } from "@/lib/validation/jobs";
import { AppError } from "@/server/errors";
import { can } from "@/server/auth/permissions";
import { loadJobRef } from "@/server/auth/job-ref";
import { withTx } from "./_shared";
import { unassignEditor } from "./assignments";
import { addLink } from "./links";
import { addNote } from "./notes";
import { shareJob, shareLink } from "./sharing";
import {
  bulkSetPriority,
  bulkTransition,
  claimJob,
  createJob,
  pauseJob,
  recomputeJobDerived,
  repairJob,
  resumeJob,
  setCompletionPercent,
  setDueDate,
  setPriority,
  updateJob,
} from "./jobs";
import { startTimer } from "./timeTracking";
import { transitionJobStatus } from "./workflow";

let db: TestDb;
let ids: SeedIds;
const T0 = "2026-10-08T00:00:00.000Z";

beforeEach(async () => {
  fakeClock.set(T0);
  db = await makeTestDb();
  ids = await seedMinimalOrg(db, { settings: { timeTrackingEnabled: true } });
  // The simplified defaults (plan §8) turn most per-type notices off; these tests check the notices themselves.
  await optInAllNotifications(db, ids);
});
afterEach(() => fakeClock.reset());

const ctxOf = (key: FixtureUserKey) => contextFor(db, ids.users[key]);
const run = <T>(fn: (tx: Tx) => Promise<T> | T): Promise<T> => withTx(fn, { db });
/** Runs `fn` as `actor`; the context is built from the root db BEFORE the transaction opens. */
async function as<T>(actor: FixtureUserKey, fn: (tx: Tx, ctx: AuthContext) => Promise<T>): Promise<T> {
  const ctx = await ctxOf(actor);
  return run((tx) => fn(tx, ctx));
}
const jobRow = async (id: string): Promise<Job> => (await first(db.select().from(jobs).where(eq(jobs.id, id)))) as Job;
const eventsOf = (jobId: string, type?: string) =>
  db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.jobId, jobId), type ? eq(activityEvents.eventType, type) : undefined))
    .orderBy(asc(activityEvents.createdAt), asc(activityEvents.rowid));
async function catchErr(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected an AppError");
}
async function expectClean() {
  const report = await verifyDerived(db);
  expect(report.drift).toEqual([]);
  expect(report.structural).toEqual([]);
}
const baseInput = () => ({ name: "Kitchen & lounge", projectId: ids.projectId, jobTypeId: ids.defaultJobTypeId });

describe("createJob", () => {
  it("creates PJ-0001 in the initial status with a creation row, photographer defaulting to the creator", async () => {
    const res = await as("photographer1", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), dueDate: "2026-10-10", priority: "high" }));
    expect(res.job).toMatchObject({
      jobNumber: "PJ-0001",
      statusId: ids.statuses.new,
      statusCategory: "new",
      clientId: ids.clientId,
      photographerId: ids.users.photographer1,
      createdByUserId: ids.users.photographer1,
      priority: "high",
      dueDate: "2026-10-10T12:59:59.999Z",
      version: 1,
    });
    expect(civilDate(res.job.dueDate, "Australia/Sydney")).toBe("2026-10-10");
    const rows = await db.select().from(jobStatusTransitions).where(eq(jobStatusTransitions.jobId, res.job.id));
    expect(rows).toEqual([expect.objectContaining({ sequence: 1, kind: "creation", fromStatusId: null, toStatusId: ids.statuses.new, activityEventId: res.eventId })]);
    const created = (await eventsOf(res.job.id, "job.created"))[0];
    expect(created.newValue).toMatchObject({ jobNumber: "PJ-0001", photographerId: ids.users.photographer1 });
    expect(created.summary).toContain("PJ-0001");
    expect(await db.select().from(jobAssignments).where(eq(jobAssignments.jobId, res.job.id))).toEqual([
      expect.objectContaining({ role: "photographer", userId: ids.users.photographer1, activityEventId: res.eventId }),
    ]);
    await expectClean();
  });

  it("with an initial editor the job lands in assigned (second transition row)", async () => {
    const res = await as("coAdmin", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), photographerId: ids.users.photographer2, editorId: ids.users.editor1 }));
    expect(res.job).toMatchObject({ statusCategory: "assigned", editorId: ids.users.editor1, photographerId: ids.users.photographer2 });
    expect(res.editorAssignment?.transition?.toStatus.category).toBe("assigned");
    expect(await db.select().from(jobStatusTransitions).where(eq(jobStatusTransitions.jobId, res.job.id))).toHaveLength(2);
    expect((await db.select().from(notifications).where(eq(notifications.type, "job_assigned"))).map((n) => n.userId).sort()).toEqual(
      [ids.users.editor1, ids.users.photographer2].sort(),
    );
    await expectClean();
  });

  it("validates client/project consistency, archived rows, foreign ids and permissions", async () => {
    const otherClient = await one(db.insert(clients).values({ organisationId: ids.organisationId, name: "Other agency" }).returning());
    expect((await catchErr(as("coAdmin", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), clientId: otherClient.id })))).status).toBe(422);
    const other = await seedMinimalOrg(db, { slug: "other" });
    expect((await catchErr(as("coAdmin", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), projectId: other.projectId })))).status).toBe(404);
    // roles v2: editors create jobs while their "Create jobs" switch is on; off → 403
    await setUserFlags(db, ids.users.editor1, { canCreateJobs: false });
    expect((await catchErr(as("editor1", (tx, ctx) => createJob(tx, ctx, baseInput())))).status).toBe(403);
    expect((await catchErr(as("coAdmin", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), editorId: ids.users.inactiveEditor })))).status).toBe(422);
    // nothing above consumed a job number
    expect((await as("coAdmin", (tx, ctx) => createJob(tx, ctx, baseInput()))).job.jobNumber).toBe("PJ-0001");
  });

  it("job numbers are gap-free under 200 creates (failed creates roll their number back)", async () => {
    const numbers: string[] = [];
    const coAdmin = await ctxOf("coAdmin");
    const photographer = await ctxOf("photographer1");
    for (let i = 0; i < 200; i++) {
      if (i % 25 === 0) {
        await catchErr(run((tx) => createJob(tx, coAdmin, { ...baseInput(), jobTypeId: "missing" })));
      }
      numbers.push((await run((tx) => createJob(tx, i % 2 ? coAdmin : photographer, { ...baseInput(), name: `Job ${i}` }))).job.jobNumber);
    }
    expect(numbers).toEqual(Array.from({ length: 200 }, (_, i) => `PJ-${String(i + 1).padStart(4, "0")}`));
    expect(new Set(numbers).size).toBe(200);
    await expectClean();
  });
});

describe("updateJob", () => {
  it("one event per changed field, version bump, dates stored as end of the civil day", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    const res = await as("photographer1", (tx, ctx) =>
      updateJob(tx, ctx, {
        jobId: job.id,
        expectedVersion: job.version,
        name: "Renamed",
        description: "",
        estimatedHours: 3.5,
        dueDate: "2026-10-12",
        priority: "urgent",
      }),
    );
    expect(res.changed.sort()).toEqual(["dueDate", "estimatedHours", "name", "priority"]);
    expect(res.job).toMatchObject({ name: "Renamed", estimatedHours: 3.5, priority: "urgent", dueDate: deadlineToIso("2026-10-12", "Australia/Sydney"), version: job.version + 1 });
    expect((await eventsOf(job.id, "job.field_changed")).map((e) => (e.newValue as { field: string }).field).sort()).toEqual(["estimatedHours", "name"]);
    expect(await eventsOf(job.id, "job.priority_changed")).toHaveLength(1);
    expect((await eventsOf(job.id, "job.due_date_changed"))[0].metadata).toMatchObject({ field: "dueDate", wasOverdue: false });
    // deadline/priority notices go to the editor (actor is the photographer, not an admin)
    expect((await db.select().from(notifications).where(eq(notifications.type, "deadline_changed"))).map((n) => n.userId)).toEqual([ids.users.editor1]);
    expect((await catchErr(as("photographer1", (tx, ctx) => updateJob(tx, ctx, { jobId: job.id, expectedVersion: job.version, name: "Again" })))).status).toBe(409);
    await expectClean();
  });

  it("per-field permissions: editors may only set completion % on assigned jobs", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    expect((await catchErr(as("editor1", (tx, ctx) => updateJob(tx, ctx, { jobId: job.id, expectedVersion: job.version, name: "x" })))).status).toBe(403);
    expect((await catchErr(as("editor1", (tx, ctx) => setPriority(tx, ctx, { jobId: job.id, expectedVersion: job.version, priority: "low" })))).status).toBe(403);
    const res = await as("editor1", (tx, ctx) => setCompletionPercent(tx, ctx, { jobId: job.id, expectedVersion: job.version, completionPercent: 40 }));
    expect(res.job.completionPercent).toBe(40);
    // a mixed patch is all-or-nothing
    expect((await catchErr(as("editor1", (tx, ctx) => updateJob(tx, ctx, { jobId: job.id, expectedVersion: res.job.version, completionPercent: 60, name: "x" })))).status).toBe(403);
    expect((await jobRow(job.id)).completionPercent).toBe(40);
  });

  it("the client follows the project; a mismatching client is rejected; the trigger backs it up", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "new" });
    const client2 = await one(db.insert(clients).values({ organisationId: ids.organisationId, name: "Coastal Homes" }).returning());
    const project2 = await one(db.insert(projects).values({ organisationId: ids.organisationId, clientId: client2.id, name: "9 Beach Rd" }).returning());
    expect((await catchErr(as("coAdmin", (tx, ctx) => updateJob(tx, ctx, { jobId: job.id, expectedVersion: job.version, clientId: client2.id })))).status).toBe(400);
    const res = await as("coAdmin", (tx, ctx) => updateJob(tx, ctx, { jobId: job.id, expectedVersion: job.version, projectId: project2.id }));
    expect(res.job).toMatchObject({ projectId: project2.id, clientId: client2.id });
    const fields = (await eventsOf(job.id, "job.field_changed")).map((e) => e.metadata);
    expect(fields).toEqual([
      expect.objectContaining({ field: "projectId", fromLabel: "123 Smith Street", toLabel: "9 Beach Rd" }),
      expect.objectContaining({ field: "clientId", fromLabel: "Harbour Realty", toLabel: "Coastal Homes" }),
    ]);
    expect(await dbRejection(db.$client.query("UPDATE jobs SET client_id = $1 WHERE id = $2", [ids.clientId, job.id]))).toMatch(/client_id must equal/);
    await expectClean();
  });

  it("setDueDate accepts an ISO instant and null; unchanged values write nothing", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "assigned", dueDate: "2026-10-01T12:59:59.999Z" });
    const res = await as("coAdmin", (tx, ctx) => setDueDate(tx, ctx, { jobId: job.id, expectedVersion: job.version, value: "2026-10-20T05:00:00+11:00" }));
    expect(res.job.dueDate).toBe("2026-10-19T18:00:00.000Z");
    expect((await eventsOf(job.id, "job.due_date_changed"))[0].metadata.wasOverdue).toBe(true);
    // admin actor → editor + photographer are told
    expect((await db.select().from(notifications).where(eq(notifications.type, "deadline_changed"))).map((n) => n.userId).sort()).toEqual(
      [ids.users.editor1, ids.users.photographer1].sort(),
    );
    const same = await as("coAdmin", (tx, ctx) => setDueDate(tx, ctx, { jobId: job.id, expectedVersion: res.job.version, value: "2026-10-19T18:00:00.000Z" }));
    expect(same.changed).toEqual([]);
    const cleared = await as("coAdmin", (tx, ctx) => setDueDate(tx, ctx, { jobId: job.id, expectedVersion: res.job.version, value: null }));
    expect(cleared.job.dueDate).toBeNull();
  });
});

describe("pause / resume", () => {
  it("pauses an editing job (closing the timer), resumes it; not allowed outside EDITOR_WORKING", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    await as("editor1", (tx, ctx) => startTimer(tx, ctx, { jobId: job.id }));
    const paused = await as("editor1", (tx, ctx) => pauseJob(tx, ctx, { jobId: job.id, expectedVersion: job.version, reason: "Waiting on assets" }));
    expect(paused.job).toMatchObject({ isPaused: true, pausedAt: T0 });
    expect(await first(db.select().from(workSessions))).toMatchObject({ endReason: "paused" });
    expect((await eventsOf(job.id, "job.paused"))[0].metadata.sessionId).toBe(paused.closedSessionIds[0]);
    expect((await db.select().from(notifications).where(eq(notifications.type, "job_paused"))).map((n) => n.userId)).toEqual([ids.users.photographer1]);
    expect((await catchErr(as("editor1", (tx, ctx) => pauseJob(tx, ctx, { jobId: job.id, expectedVersion: paused.job.version })))).status).toBe(400);
    const resumed = await as("coAdmin", (tx, ctx) => resumeJob(tx, ctx, { jobId: job.id, expectedVersion: paused.job.version }));
    expect(resumed.job).toMatchObject({ isPaused: false, pausedAt: null });
    expect((await eventsOf(job.id, "job.resumed"))[0].metadata.onBehalfOf).toBe(ids.users.editor1);

    const submitted = (await insertJobFixture(db, ids, { statusKey: "submitted" })).job;
    expect((await catchErr(as("editor1", (tx, ctx) => pauseJob(tx, ctx, { jobId: submitted.id, expectedVersion: submitted.version })))).status).toBe(403);
    await expectClean();
  });
});

describe("bulk", () => {
  it("bulkSetPriority / bulkTransition: per-job transactions with a shared batchId", async () => {
    const a = (await insertJobFixture(db, ids, { statusKey: "approved" })).job;
    const b = (await insertJobFixture(db, ids, { statusKey: "delivered" })).job;
    const c = (await insertJobFixture(db, ids, { statusKey: "in_progress" })).job;
    const pr = await bulkSetPriority(await ctxOf("coAdmin"), { jobIds: [a.id, b.id], priority: "urgent" }, { db });
    expect(pr.ok).toEqual([a.id, b.id]);
    expect((await jobRow(a.id)).priority).toBe("urgent");
    const tr = await bulkTransition(await ctxOf("coAdmin"), { jobIds: [a.id, b.id, c.id], toCategory: "completed" }, { db });
    expect(tr.ok).toEqual([a.id, b.id]);
    expect(tr.failed).toEqual([{ id: c.id, code: "invalid_transition", message: expect.any(String) }]);
    const tagged = await db.select().from(activityEvents).where(eq(activityEvents.eventType, "job.status_changed"));
    expect(tagged.map((e) => e.metadata.batchId)).toEqual([tr.batchId, tr.batchId]);
    await expectClean();
  });
});

describe("recomputeJobDerived", () => {
  it("repairs tampered pointers from the ledgers and audits each with cause recompute", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "submitted" });
    await as("photographer1", (tx, ctx) =>
      transitionJobStatus(tx, ctx, {
        jobId: job.id,
        toCategory: "revision",
        expectedVersion: job.version,
        revision: { reason: "Colour", description: "Too cold" },
      }),
    );
    await expectClean();
    await db.$client.query("UPDATE jobs SET editor_id = $1, revision_count = 7, open_revision_id = NULL, previous_status_id = NULL WHERE id = $2", [ids.users.editor2, job.id]);
    const drift = (await verifyDerived(db)).drift.map((d) => d.column).sort();
    expect(drift).toEqual(["editor_id", "open_revision_id", "previous_status_id", "revision_count"]);

    // system.integrity is admin-only: a team member with every switch (a migrated v1 manager) is refused
    expect((await catchErr(as("lead", (tx, ctx) => repairJob(tx, ctx, { jobId: job.id })))).status).toBe(403);
    fakeClock.advanceMinutes(5);
    const res = await as("owner", (tx, ctx) => repairJob(tx, ctx, { jobId: job.id }));
    expect(res.changes.map((c) => c.column).sort()).toEqual(["editorId", "openRevisionId", "previousStatusId", "revisionCount"]);
    await expectClean();
    const audit = await db.select().from(activityEvents).where(and(eq(activityEvents.jobId, job.id), eq(activityEvents.eventType, "job.field_changed"))).orderBy(asc(activityEvents.createdAt));
    expect(audit).toHaveLength(4);
    expect(audit.every((e) => e.metadata.cause === "recompute" && e.actorUserId === ids.users.owner)).toBe(true);
    // idempotent; works without a context (system, cause recompute)
    expect((await run((tx) => recomputeJobDerived(tx, job.id))).changes).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  roles v2 (docs/ROLES.md §4, §4.5)                                   */
/* ------------------------------------------------------------------ */

describe("roles v2: createJob per persona", () => {
  it("admin: any active photographer (default self); allow-listed targets only", async () => {
    const own = await as("owner", (tx, ctx) => createJob(tx, ctx, baseInput()));
    expect(own.job).toMatchObject({ photographerId: ids.users.owner, createdByRole: "photographer" });
    const forOther = await as("owner", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), photographerId: ids.users.photographer2 }));
    expect(forOther.job.photographerId).toBe(ids.users.photographer2);
    // an editor, a client user or a foreign id is never a photographer
    expect((await catchErr(as("owner", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), photographerId: ids.users.editor1 })))).status).toBe(422);
    expect((await catchErr(as("owner", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), photographerId: ids.users.client })))).status).toBe(422);
    const other = await seedMinimalOrg(db, { slug: "other" });
    expect((await catchErr(as("owner", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), photographerId: other.users.photographer1 })))).status).toBe(404);
    expect((await eventsOf(own.job.id, "job.created"))[0].metadata).toMatchObject({ creatorRole: "photographer" });
  });

  it("team member: photographer forced to self; Create jobs off → 403; editorId needs Assign editors", async () => {
    const own = await as("photographer1", (tx, ctx) => createJob(tx, ctx, baseInput()));
    expect(own.job.photographerId).toBe(ids.users.photographer1);
    const forced = await catchErr(as("photographer1", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), photographerId: ids.users.photographer2 })));
    expect(forced.status).toBe(403);

    const junior = await inviteDefaultsMember(db, ids); // create ✓, assign ✓, review ✗
    await setUserFlags(db, junior, { canAssignEditors: false });
    const juniorCtx = await contextFor(db, junior);
    expect((await catchErr(run((tx) => createJob(tx, juniorCtx, { ...baseInput(), editorId: ids.users.editor1 })))).status).toBe(403);
    const ok = await run((tx) => createJob(tx, juniorCtx, baseInput()));
    expect(ok.job).toMatchObject({ photographerId: junior, editorId: null });

    await setUserFlags(db, junior, { canCreateJobs: false });
    const noCreate = await contextFor(db, junior);
    expect((await catchErr(run((tx) => createJob(tx, noCreate, baseInput())))).status).toBe(403);
  });

  it("editor: photographer required, default from the org setting, falling back to the primary owner", async () => {
    const a = await as("editor1", (tx, ctx) => createJob(tx, ctx, baseInput()));
    expect(a.job).toMatchObject({ photographerId: ids.users.owner, createdByRole: "editor", createdByUserId: ids.users.editor1, editorId: null });
    expect((await eventsOf(a.job.id, "job.created"))[0].metadata).toMatchObject({ creatorRole: "editor" });
    await db.update(organisationSettings).set({ defaultPhotographerUserId: ids.users.photographer2 }).where(eq(organisationSettings.organisationId, ids.organisationId));
    const b = await as("editor1", (tx, ctx) => createJob(tx, ctx, baseInput()));
    expect(b.job.photographerId).toBe(ids.users.photographer2);
    await db.update(users).set({ isActive: false }).where(eq(users.id, ids.users.photographer2));
    const c = await as("editor1", (tx, ctx) => createJob(tx, ctx, baseInput()));
    expect(c.job.photographerId).toBe(ids.users.owner);
    expect((await as("editor1", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), photographerId: ids.users.photographer1 }))).job.photographerId).toBe(ids.users.photographer1);
    expect((await catchErr(as("editor1", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), photographerId: null })))).status).toBe(422);
    expect((await catchErr(as("editor1", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), photographerId: ids.users.client })))).status).toBe(422);
    expect((await catchErr(as("editor1", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), photographerId: ids.users.editor2 })))).status).toBe(422);
    await expectClean();
  });

  it("editor: assign to me (job.claim) or leave unassigned; another editor → 403; unassigned notifies admins once", async () => {
    expect((await catchErr(as("editor1", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), editorId: ids.users.editor2 })))).status).toBe(403);
    const mine = await as("editor1", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), photographerId: ids.users.photographer1, editorId: ids.users.editor1 }));
    expect(mine.job).toMatchObject({ editorId: ids.users.editor1, statusCategory: "assigned" });
    const assignment = await first(db.select().from(jobAssignments).where(and(eq(jobAssignments.jobId, mine.job.id), eq(jobAssignments.role, "editor"))));
    expect(assignment).toMatchObject({ userId: ids.users.editor1, reason: "Self-assigned at creation" });

    const open = await as("editor1", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), photographerId: ids.users.photographer1 }));
    const fresh = (await db.select().from(notifications)).filter((n) => n.jobId === open.job.id);
    // admins get job_created; photographer1 (member with Assign editors) already got job_assigned → one notice
    expect(fresh.filter((n) => n.type === "job_created").map((n) => n.userId).sort()).toEqual([ids.users.coAdmin, ids.users.owner].sort());
    expect(fresh.filter((n) => n.userId === ids.users.photographer1).map((n) => n.type)).toEqual(["job_assigned"]);
    expect(fresh.find((n) => n.type === "job_created")?.title).toMatch(/needs an editor/);
    await expectClean();
  });

  it("editor: inline new project under an existing client (project.created by the editor)", async () => {
    const res = await as("editor1", (tx, ctx) =>
      createJob(tx, ctx, { name: "14 Ocean St · twilight", clientId: ids.clientId, newProject: { name: "14 Ocean St", address: "14 Ocean St, Bondi" }, jobTypeId: ids.defaultJobTypeId }),
    );
    const project = await one(db.select().from(projects).where(eq(projects.id, res.job.projectId)));
    expect(project).toMatchObject({ name: "14 Ocean St", clientId: ids.clientId, createdByUserId: ids.users.editor1, sharedWithClient: false });
    const created = await db.select().from(activityEvents).where(eq(activityEvents.entityId, project.id));
    expect(created.map((e) => e.eventType)).toEqual(["project.created"]);
    expect(created[0].actorUserId).toBe(ids.users.editor1);
    // XOR projectId / newProject; newProject needs clientId; archived client refused
    expect((await catchErr(as("editor1", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), newProject: { name: "x" }, clientId: ids.clientId })))).status).toBe(400);
    expect((await catchErr(as("editor1", (tx, ctx) => createJob(tx, ctx, { name: "x", newProject: { name: "x" }, jobTypeId: ids.defaultJobTypeId })))).status).toBe(400);
    await db.update(clients).set({ archivedAt: T0 }).where(eq(clients.id, ids.clientId2));
    expect((await catchErr(as("editor1", (tx, ctx) => createJob(tx, ctx, { name: "x", clientId: ids.clientId2, newProject: { name: "y" }, jobTypeId: ids.defaultJobTypeId })))).status).toBe(422);
    await expectClean();
  });

  it("strict input: sharing columns and unknown keys → 400", async () => {
    expect((await catchErr(as("owner", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), sharedWithClient: true })))).status).toBe(400);
    const { job } = await insertJobFixture(db, ids);
    expect((await catchErr(as("owner", (tx, ctx) => updateJob(tx, ctx, { jobId: job.id, expectedVersion: job.version, sharedWithClient: true })))).status).toBe(400);
    expect((await jobRow(job.id)).sharedWithClient).toBe(false);
  });
});

describe("roles v2: editor draft window and claim", () => {
  it("the creator edits fields / dates while in draft; Start closes the window for good", async () => {
    const { job } = await as("editor1", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), editorId: ids.users.editor1 }));
    const renamed = await as("editor1", (tx, ctx) => updateJob(tx, ctx, { jobId: job.id, expectedVersion: job.version, name: "Renamed by creator", dueDate: "2026-10-11", priority: "high" }));
    expect(renamed.job).toMatchObject({ name: "Renamed by creator", priority: "high" });
    const started = await as("editor1", (tx, ctx) => transitionJobStatus(tx, ctx, { jobId: job.id, toCategory: "in_progress", expectedVersion: renamed.job.version }));
    expect(started.job.statusCategory).toBe("in_progress");
    expect((await catchErr(as("editor1", (tx, ctx) => updateJob(tx, ctx, { jobId: job.id, expectedVersion: started.job.version, name: "Again" })))).status).toBe(403);
    expect((await as("editor1", (tx, ctx) => setCompletionPercent(tx, ctx, { jobId: job.id, expectedVersion: started.job.version, completionPercent: 30 }))).job.completionPercent).toBe(30);
    await expectClean();
  });

  it("claimJob: the creator takes an unassigned draft; an admin's unassign closes the window (claim + edits 403)", async () => {
    const { job } = await as("editor1", (tx, ctx) => createJob(tx, ctx, baseInput()));
    const claimed = await as("editor1", (tx, ctx) => claimJob(tx, ctx, { jobId: job.id, expectedVersion: job.version }));
    expect(claimed.job).toMatchObject({ editorId: ids.users.editor1, statusCategory: "assigned" });
    expect((await catchErr(as("editor2", (tx, ctx) => claimJob(tx, ctx, { jobId: job.id, expectedVersion: claimed.job.version })))).status).toBe(404);

    const unassigned = await as("owner", (tx, ctx) => unassignEditor(tx, ctx, { jobId: job.id, expectedVersion: claimed.job.version }));
    expect(unassigned.job.editorId).toBeNull();
    expect((await catchErr(as("editor1", (tx, ctx) => claimJob(tx, ctx, { jobId: job.id, expectedVersion: unassigned.job.version })))).status).toBe(403);
    expect((await catchErr(as("editor1", (tx, ctx) => updateJob(tx, ctx, { jobId: job.id, expectedVersion: unassigned.job.version, name: "x" })))).status).toBe(403);
    await expectClean();
  });

  it("claim needs an unassigned new/ready job the editor created", async () => {
    const other = (await insertJobFixture(db, ids, { statusKey: "ready", createdByUserId: ids.users.owner, editorId: null })).job;
    expect((await catchErr(as("editor1", (tx, ctx) => claimJob(tx, ctx, { jobId: other.id, expectedVersion: other.version })))).status).toBe(404);
    const created = (await insertJobFixture(db, ids, { statusKey: "ready", createdByUserId: ids.users.editor1, editorId: null })).job;
    const res = await as("editor1", (tx, ctx) => claimJob(tx, ctx, { jobId: created.id, expectedVersion: created.version }));
    expect(res.job.editorId).toBe(ids.users.editor1);
  });

  it("created_by_role is fixed at creation (never updated by later edits; CHECK backs it)", async () => {
    const { job } = await as("editor1", (tx, ctx) => createJob(tx, ctx, baseInput()));
    await as("owner", (tx, ctx) => updateJob(tx, ctx, { jobId: job.id, expectedVersion: job.version, name: "Owner edit" }));
    expect((await jobRow(job.id)).createdByRole).toBe("editor");
    expect(await dbRejection(db.$client.query("UPDATE jobs SET created_by_role = 'client' WHERE id = $1", [job.id]))).toMatch(/jobs_created_by_role_ck|check constraint/);
  });
});

describe("roles v2: controls (cancel / dates on jobs someone else created)", () => {
  it("a member who is only the photographer needs Review submissions to re-date or cancel an owner-created job", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "ready", createdByUserId: ids.users.owner, photographerId: ids.users.photographer1, editorId: null });
    await setUserFlags(db, ids.users.photographer1, { canReviewSubmissions: false });
    expect((await catchErr(as("photographer1", (tx, ctx) => setDueDate(tx, ctx, { jobId: job.id, expectedVersion: job.version, value: "2026-10-20" })))).status).toBe(403);
    expect((await catchErr(as("photographer1", (tx, ctx) => transitionJobStatus(tx, ctx, { jobId: job.id, toCategory: "cancelled", expectedVersion: job.version, reason: "x" })))).status).toBe(403);
    const renamed = await as("photographer1", (tx, ctx) => updateJob(tx, ctx, { jobId: job.id, expectedVersion: job.version, name: "Shot by me" }));
    await setUserFlags(db, ids.users.photographer1, { canReviewSubmissions: true });
    const dated = await as("photographer1", (tx, ctx) => setDueDate(tx, ctx, { jobId: job.id, expectedVersion: renamed.job.version, value: "2026-10-20" }));
    const cancelled = await as("photographer1", (tx, ctx) => transitionJobStatus(tx, ctx, { jobId: job.id, toCategory: "cancelled", expectedVersion: dated.job.version, reason: "Client cancelled" }));
    expect(cancelled.job.statusCategory).toBe("cancelled");
    await expectClean();
  });

  it("unchanged fields sent by a form are not permission-checked", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "ready", createdByUserId: ids.users.owner, photographerId: ids.users.photographer1, editorId: null, dueDate: deadlineToIso("2026-10-01", "Australia/Sydney") });
    await setUserFlags(db, ids.users.photographer1, { canReviewSubmissions: false });
    const res = await as("photographer1", (tx, ctx) =>
      updateJob(tx, ctx, { jobId: job.id, expectedVersion: job.version, name: "New name", dueDate: "2026-10-01", projectId: ids.projectId, priority: "normal" }),
    );
    expect(res.changed).toEqual(["name"]);
  });
});

describe("roles v2: client / project change (§4.5)", () => {
  async function sharedJobWithLinkAndNote() {
    const { job } = await insertJobFixture(db, ids, { statusKey: "approved", createdByUserId: ids.users.owner, photographerId: ids.users.owner, sharedWithClient: true });
    const link = await as("owner", (tx, ctx) => addLink(tx, ctx, { jobId: job.id, kind: "gallery", url: "https://example.pixieset.com/a" }));
    await as("owner", (tx, ctx) => shareLink(tx, ctx, { linkId: link.id, shared: true }));
    const note = await as("owner", (tx, ctx) => addNote(tx, ctx, { jobId: job.id, kind: "delivery", body: "Your photos are ready" }));
    return { job: await jobRow(job.id), linkId: link.id, noteId: note.id };
  }

  it("moving to another client unshares the job and its links and archives delivery notes (reason client_changed)", async () => {
    const { job, linkId, noteId } = await sharedJobWithLinkAndNote();
    const res = await as("owner", (tx, ctx) => updateJob(tx, ctx, { jobId: job.id, expectedVersion: job.version, projectId: ids.projectId2 }));
    expect(res.job).toMatchObject({ clientId: ids.clientId2, sharedWithClient: false, version: job.version + 1 });
    expect(res.clientChangeReset).toMatchObject({ unsharedLinkIds: [linkId], archivedNoteIds: [noteId] });
    expect((await one(db.select().from(jobLinks).where(eq(jobLinks.id, linkId)))).sharedWithClient).toBe(false);
    expect((await one(db.select().from(jobNotes).where(eq(jobNotes.id, noteId)))).archivedAt).not.toBeNull();
    const reasons = (await db.select().from(activityEvents).where(eq(activityEvents.jobId, job.id)))
      .filter((e) => ["job.client_sharing_changed", "link.client_sharing_changed", "note.archived"].includes(e.eventType) && e.metadata.reason === "client_changed")
      .map((e) => e.eventType)
      .sort();
    expect(reasons).toEqual(["job.client_sharing_changed", "link.client_sharing_changed", "note.archived"]);
    const { ref } = await loadJobRef(db, { organisationId: ids.organisationId }, job.id);
    expect(can(await ctxOf("client"), "portal.view_job", ref)).toBe(false);
    expect(can(await ctxOf("client2"), "portal.view_job", ref)).toBe(false);
    await expectClean();
  });

  it("a move that could publish needs job.share_with_client (member without Review; editor in draft)", async () => {
    await db.update(projects).set({ sharedWithClient: true }).where(eq(projects.id, ids.projectId2));
    const memberJob = (await insertJobFixture(db, ids, { statusKey: "ready", createdByUserId: ids.users.photographer1, editorId: null })).job;
    await setUserFlags(db, ids.users.photographer1, { canReviewSubmissions: false });
    expect((await catchErr(as("photographer1", (tx, ctx) => updateJob(tx, ctx, { jobId: memberJob.id, expectedVersion: memberJob.version, projectId: ids.projectId2 })))).status).toBe(403);
    const { job: draft } = await as("editor1", (tx, ctx) => createJob(tx, ctx, baseInput()));
    expect((await catchErr(as("editor1", (tx, ctx) => updateJob(tx, ctx, { jobId: draft.id, expectedVersion: draft.version, projectId: ids.projectId2 })))).status).toBe(403);
    // creating INTO a shared project is allowed (the project share covers future jobs)
    const into = await as("editor1", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), projectId: ids.projectId2 }));
    expect(into.job.projectId).toBe(ids.projectId2);
    await setUserFlags(db, ids.users.photographer1, { canReviewSubmissions: true });
    const moved = await as("photographer1", (tx, ctx) => updateJob(tx, ctx, { jobId: memberJob.id, expectedVersion: memberJob.version, projectId: ids.projectId2 }));
    expect(moved.job.projectId).toBe(ids.projectId2);
  });
});

describe("roles v2: shareJob", () => {
  it("toggles jobs.shared_with_client with an event + version bump and tells portal users once", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress", createdByUserId: ids.users.owner });
    const res = await as("owner", (tx, ctx) => shareJob(tx, ctx, { jobId: job.id, shared: true, expectedVersion: job.version }));
    expect(res).toMatchObject({ changed: true, notifiedUserIds: [ids.users.client] });
    expect(res.job).toMatchObject({ sharedWithClient: true, version: job.version + 1 });
    const evt = (await eventsOf(job.id, "job.client_sharing_changed"))[0];
    expect(evt).toMatchObject({ previousValue: { shared: false }, newValue: { shared: true } });
    expect(evt.metadata).toMatchObject({ reason: "manual", cause: "user" });
    expect((await db.select().from(notifications).where(eq(notifications.type, "client_work_shared"))).map((n) => n.userId)).toEqual([ids.users.client]);
    const again = await as("owner", (tx, ctx) => shareJob(tx, ctx, { jobId: job.id, shared: true, expectedVersion: res.job.version }));
    expect(again.changed).toBe(false);
    expect((await catchErr(as("owner", (tx, ctx) => shareJob(tx, ctx, { jobId: job.id, shared: false, expectedVersion: job.version })))).status).toBe(409);
    expect((await catchErr(as("editor1", (tx, ctx) => shareJob(tx, ctx, { jobId: job.id, shared: false, expectedVersion: res.job.version })))).status).toBe(403);
    await expectClean();
  });
});
