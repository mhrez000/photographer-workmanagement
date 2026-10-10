import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first, one, type Tx } from "@/db/index";
import { activityEvents, clients, jobAssignments, jobStatusTransitions, jobs, notifications, projects, workSessions } from "@/db/schema";
import { contextFor, dbRejection, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type FixtureUserKey, type SeedIds, type TestDb } from "@/db/test-db";
import { verifyDerived } from "@/db/verify";
import { civilDate } from "@/lib/dates";
import type { AuthContext, Job } from "@/lib/types";
import { deadlineToIso } from "@/lib/validation/jobs";
import { AppError } from "@/server/errors";
import { withTx } from "./_shared";
import {
  bulkSetPriority,
  bulkTransition,
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
    const res = await as("manager", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), photographerId: ids.users.photographer2, editorId: ids.users.editor1 }));
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
    expect((await catchErr(as("manager", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), clientId: otherClient.id })))).status).toBe(400);
    const other = await seedMinimalOrg(db, { slug: "other" });
    expect((await catchErr(as("manager", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), projectId: other.projectId })))).status).toBe(404);
    expect((await catchErr(as("editor1", (tx, ctx) => createJob(tx, ctx, baseInput())))).status).toBe(403);
    expect((await catchErr(as("manager", (tx, ctx) => createJob(tx, ctx, { ...baseInput(), editorId: ids.users.inactiveEditor })))).status).toBe(400);
    // nothing above consumed a job number
    expect((await as("manager", (tx, ctx) => createJob(tx, ctx, baseInput()))).job.jobNumber).toBe("PJ-0001");
  });

  it("job numbers are gap-free under 200 creates (failed creates roll their number back)", async () => {
    const numbers: string[] = [];
    const manager = await ctxOf("manager");
    const photographer = await ctxOf("photographer1");
    for (let i = 0; i < 200; i++) {
      if (i % 25 === 0) {
        await catchErr(run((tx) => createJob(tx, manager, { ...baseInput(), jobTypeId: "missing" })));
      }
      numbers.push((await run((tx) => createJob(tx, i % 2 ? manager : photographer, { ...baseInput(), name: `Job ${i}` }))).job.jobNumber);
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
    // deadline/priority notices go to the editor (actor is the photographer, not a manager)
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
    expect((await catchErr(as("manager", (tx, ctx) => updateJob(tx, ctx, { jobId: job.id, expectedVersion: job.version, clientId: client2.id })))).status).toBe(400);
    const res = await as("manager", (tx, ctx) => updateJob(tx, ctx, { jobId: job.id, expectedVersion: job.version, projectId: project2.id }));
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
    const res = await as("manager", (tx, ctx) => setDueDate(tx, ctx, { jobId: job.id, expectedVersion: job.version, value: "2026-10-20T05:00:00+11:00" }));
    expect(res.job.dueDate).toBe("2026-10-19T18:00:00.000Z");
    expect((await eventsOf(job.id, "job.due_date_changed"))[0].metadata.wasOverdue).toBe(true);
    // manager actor → editor + photographer are told
    expect((await db.select().from(notifications).where(eq(notifications.type, "deadline_changed"))).map((n) => n.userId).sort()).toEqual(
      [ids.users.editor1, ids.users.photographer1].sort(),
    );
    const same = await as("manager", (tx, ctx) => setDueDate(tx, ctx, { jobId: job.id, expectedVersion: res.job.version, value: "2026-10-19T18:00:00.000Z" }));
    expect(same.changed).toEqual([]);
    const cleared = await as("manager", (tx, ctx) => setDueDate(tx, ctx, { jobId: job.id, expectedVersion: res.job.version, value: null }));
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
    const resumed = await as("manager", (tx, ctx) => resumeJob(tx, ctx, { jobId: job.id, expectedVersion: paused.job.version }));
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
    const pr = await bulkSetPriority(await ctxOf("manager"), { jobIds: [a.id, b.id], priority: "urgent" }, { db });
    expect(pr.ok).toEqual([a.id, b.id]);
    expect((await jobRow(a.id)).priority).toBe("urgent");
    const tr = await bulkTransition(await ctxOf("manager"), { jobIds: [a.id, b.id, c.id], toCategory: "completed" }, { db });
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

    expect((await catchErr(as("manager", (tx, ctx) => repairJob(tx, ctx, { jobId: job.id })))).status).toBe(403);
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
