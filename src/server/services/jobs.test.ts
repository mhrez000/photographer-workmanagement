import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tx } from "@/db/index";
import { activityEvents, clients, jobAssignments, jobStatusTransitions, jobs, notifications, projects, workSessions } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type FixtureUserKey, type SeedIds, type TestDb } from "@/db/test-db";
import { verifyDerived } from "@/db/verify";
import { civilDate } from "@/lib/dates";
import type { Job } from "@/lib/types";
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

beforeEach(() => {
  fakeClock.set(T0);
  db = makeTestDb();
  ids = seedMinimalOrg(db, { settings: { timeTrackingEnabled: true } });
});
afterEach(() => fakeClock.reset());

const ctxOf = (key: FixtureUserKey) => contextFor(db, ids.users[key]);
const run = <T>(fn: (tx: Tx) => T): T => withTx(fn, { db });
const jobRow = (id: string): Job => db.select().from(jobs).where(eq(jobs.id, id)).get() as Job;
const eventsOf = (jobId: string, type?: string) =>
  db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.jobId, jobId), type ? eq(activityEvents.eventType, type) : undefined))
    .all();
function catchErr(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected an AppError");
}
function expectClean() {
  const report = verifyDerived(db.$client);
  expect(report.drift).toEqual([]);
  expect(report.structural).toEqual([]);
}
const baseInput = () => ({ name: "Kitchen & lounge", projectId: ids.projectId, jobTypeId: ids.defaultJobTypeId });

describe("createJob", () => {
  it("creates PJ-0001 in the initial status with a creation row, photographer defaulting to the creator", () => {
    const res = run((tx) => createJob(tx, ctxOf("photographer1"), { ...baseInput(), dueDate: "2026-10-10", priority: "high" }));
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
    const rows = db.select().from(jobStatusTransitions).where(eq(jobStatusTransitions.jobId, res.job.id)).all();
    expect(rows).toEqual([expect.objectContaining({ sequence: 1, kind: "creation", fromStatusId: null, toStatusId: ids.statuses.new, activityEventId: res.eventId })]);
    const created = eventsOf(res.job.id, "job.created")[0];
    expect(created.newValue).toMatchObject({ jobNumber: "PJ-0001", photographerId: ids.users.photographer1 });
    expect(created.summary).toContain("PJ-0001");
    expect(db.select().from(jobAssignments).where(eq(jobAssignments.jobId, res.job.id)).all()).toEqual([
      expect.objectContaining({ role: "photographer", userId: ids.users.photographer1, activityEventId: res.eventId }),
    ]);
    expectClean();
  });

  it("with an initial editor the job lands in assigned (second transition row)", () => {
    const res = run((tx) => createJob(tx, ctxOf("manager"), { ...baseInput(), photographerId: ids.users.photographer2, editorId: ids.users.editor1 }));
    expect(res.job).toMatchObject({ statusCategory: "assigned", editorId: ids.users.editor1, photographerId: ids.users.photographer2 });
    expect(res.editorAssignment?.transition?.toStatus.category).toBe("assigned");
    expect(db.select().from(jobStatusTransitions).where(eq(jobStatusTransitions.jobId, res.job.id)).all()).toHaveLength(2);
    expect(db.select().from(notifications).where(eq(notifications.type, "job_assigned")).all().map((n) => n.userId).sort()).toEqual(
      [ids.users.editor1, ids.users.photographer2].sort(),
    );
    expectClean();
  });

  it("validates client/project consistency, archived rows, foreign ids and permissions", () => {
    const otherClient = db.insert(clients).values({ organisationId: ids.organisationId, name: "Other agency" }).returning().get();
    expect(catchErr(() => run((tx) => createJob(tx, ctxOf("manager"), { ...baseInput(), clientId: otherClient.id }))).status).toBe(400);
    const other = seedMinimalOrg(db, { slug: "other" });
    expect(catchErr(() => run((tx) => createJob(tx, ctxOf("manager"), { ...baseInput(), projectId: other.projectId }))).status).toBe(404);
    expect(catchErr(() => run((tx) => createJob(tx, ctxOf("editor1"), baseInput()))).status).toBe(403);
    expect(catchErr(() => run((tx) => createJob(tx, ctxOf("manager"), { ...baseInput(), editorId: ids.users.inactiveEditor }))).status).toBe(400);
    // nothing above consumed a job number
    expect(run((tx) => createJob(tx, ctxOf("manager"), baseInput())).job.jobNumber).toBe("PJ-0001");
  });

  it("job numbers are gap-free under 200 creates (failed creates roll their number back)", () => {
    const numbers: string[] = [];
    for (let i = 0; i < 200; i++) {
      if (i % 25 === 0) {
        catchErr(() => run((tx) => createJob(tx, ctxOf("manager"), { ...baseInput(), jobTypeId: "missing" })));
      }
      numbers.push(run((tx) => createJob(tx, ctxOf(i % 2 ? "manager" : "photographer1"), { ...baseInput(), name: `Job ${i}` })).job.jobNumber);
    }
    expect(numbers).toEqual(Array.from({ length: 200 }, (_, i) => `PJ-${String(i + 1).padStart(4, "0")}`));
    expect(new Set(numbers).size).toBe(200);
    expectClean();
  });
});

describe("updateJob", () => {
  it("one event per changed field, version bump, dates stored as end of the civil day", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress" });
    const res = run((tx) =>
      updateJob(tx, ctxOf("photographer1"), {
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
    expect(eventsOf(job.id, "job.field_changed").map((e) => (e.newValue as { field: string }).field).sort()).toEqual(["estimatedHours", "name"]);
    expect(eventsOf(job.id, "job.priority_changed")).toHaveLength(1);
    expect(eventsOf(job.id, "job.due_date_changed")[0].metadata).toMatchObject({ field: "dueDate", wasOverdue: false });
    // deadline/priority notices go to the editor (actor is the photographer, not a manager)
    expect(db.select().from(notifications).where(eq(notifications.type, "deadline_changed")).all().map((n) => n.userId)).toEqual([ids.users.editor1]);
    expect(catchErr(() => run((tx) => updateJob(tx, ctxOf("photographer1"), { jobId: job.id, expectedVersion: job.version, name: "Again" }))).status).toBe(409);
    expectClean();
  });

  it("per-field permissions: editors may only set completion % on assigned jobs", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress" });
    expect(catchErr(() => run((tx) => updateJob(tx, ctxOf("editor1"), { jobId: job.id, expectedVersion: job.version, name: "x" }))).status).toBe(403);
    expect(catchErr(() => run((tx) => setPriority(tx, ctxOf("editor1"), { jobId: job.id, expectedVersion: job.version, priority: "low" }))).status).toBe(403);
    const res = run((tx) => setCompletionPercent(tx, ctxOf("editor1"), { jobId: job.id, expectedVersion: job.version, completionPercent: 40 }));
    expect(res.job.completionPercent).toBe(40);
    // a mixed patch is all-or-nothing
    expect(catchErr(() => run((tx) => updateJob(tx, ctxOf("editor1"), { jobId: job.id, expectedVersion: res.job.version, completionPercent: 60, name: "x" }))).status).toBe(403);
    expect(jobRow(job.id).completionPercent).toBe(40);
  });

  it("the client follows the project; a mismatching client is rejected; the trigger backs it up", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "new" });
    const client2 = db.insert(clients).values({ organisationId: ids.organisationId, name: "Coastal Homes" }).returning().get();
    const project2 = db.insert(projects).values({ organisationId: ids.organisationId, clientId: client2.id, name: "9 Beach Rd" }).returning().get();
    expect(catchErr(() => run((tx) => updateJob(tx, ctxOf("manager"), { jobId: job.id, expectedVersion: job.version, clientId: client2.id }))).status).toBe(400);
    const res = run((tx) => updateJob(tx, ctxOf("manager"), { jobId: job.id, expectedVersion: job.version, projectId: project2.id }));
    expect(res.job).toMatchObject({ projectId: project2.id, clientId: client2.id });
    const fields = eventsOf(job.id, "job.field_changed").map((e) => e.metadata);
    expect(fields).toEqual([
      expect.objectContaining({ field: "projectId", fromLabel: "123 Smith Street", toLabel: "9 Beach Rd" }),
      expect.objectContaining({ field: "clientId", fromLabel: "Harbour Realty", toLabel: "Coastal Homes" }),
    ]);
    expect(() => db.$client.prepare("UPDATE jobs SET client_id = ? WHERE id = ?").run(ids.clientId, job.id)).toThrow(/client_id must equal/);
    expectClean();
  });

  it("setDueDate accepts an ISO instant and null; unchanged values write nothing", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "assigned", dueDate: "2026-10-01T12:59:59.999Z" });
    const res = run((tx) => setDueDate(tx, ctxOf("manager"), { jobId: job.id, expectedVersion: job.version, value: "2026-10-20T05:00:00+11:00" }));
    expect(res.job.dueDate).toBe("2026-10-19T18:00:00.000Z");
    expect(eventsOf(job.id, "job.due_date_changed")[0].metadata.wasOverdue).toBe(true);
    // manager actor → editor + photographer are told
    expect(db.select().from(notifications).where(eq(notifications.type, "deadline_changed")).all().map((n) => n.userId).sort()).toEqual(
      [ids.users.editor1, ids.users.photographer1].sort(),
    );
    const same = run((tx) => setDueDate(tx, ctxOf("manager"), { jobId: job.id, expectedVersion: res.job.version, value: "2026-10-19T18:00:00.000Z" }));
    expect(same.changed).toEqual([]);
    const cleared = run((tx) => setDueDate(tx, ctxOf("manager"), { jobId: job.id, expectedVersion: res.job.version, value: null }));
    expect(cleared.job.dueDate).toBeNull();
  });
});

describe("pause / resume", () => {
  it("pauses an editing job (closing the timer), resumes it; not allowed outside EDITOR_WORKING", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress" });
    run((tx) => startTimer(tx, ctxOf("editor1"), { jobId: job.id }));
    const paused = run((tx) => pauseJob(tx, ctxOf("editor1"), { jobId: job.id, expectedVersion: job.version, reason: "Waiting on assets" }));
    expect(paused.job).toMatchObject({ isPaused: true, pausedAt: T0 });
    expect(db.select().from(workSessions).get()).toMatchObject({ endReason: "paused" });
    expect(eventsOf(job.id, "job.paused")[0].metadata.sessionId).toBe(paused.closedSessionIds[0]);
    expect(db.select().from(notifications).where(eq(notifications.type, "job_paused")).all().map((n) => n.userId)).toEqual([ids.users.photographer1]);
    expect(catchErr(() => run((tx) => pauseJob(tx, ctxOf("editor1"), { jobId: job.id, expectedVersion: paused.job.version }))).status).toBe(400);
    const resumed = run((tx) => resumeJob(tx, ctxOf("manager"), { jobId: job.id, expectedVersion: paused.job.version }));
    expect(resumed.job).toMatchObject({ isPaused: false, pausedAt: null });
    expect(eventsOf(job.id, "job.resumed")[0].metadata.onBehalfOf).toBe(ids.users.editor1);

    const submitted = insertJobFixture(db, ids, { statusKey: "submitted" }).job;
    expect(catchErr(() => run((tx) => pauseJob(tx, ctxOf("editor1"), { jobId: submitted.id, expectedVersion: submitted.version }))).status).toBe(403);
    expectClean();
  });
});

describe("bulk", () => {
  it("bulkSetPriority / bulkTransition: per-job transactions with a shared batchId", () => {
    const a = insertJobFixture(db, ids, { statusKey: "approved" }).job;
    const b = insertJobFixture(db, ids, { statusKey: "delivered" }).job;
    const c = insertJobFixture(db, ids, { statusKey: "in_progress" }).job;
    const pr = bulkSetPriority(ctxOf("manager"), { jobIds: [a.id, b.id], priority: "urgent" }, { db });
    expect(pr.ok).toEqual([a.id, b.id]);
    expect(jobRow(a.id).priority).toBe("urgent");
    const tr = bulkTransition(ctxOf("manager"), { jobIds: [a.id, b.id, c.id], toCategory: "completed" }, { db });
    expect(tr.ok).toEqual([a.id, b.id]);
    expect(tr.failed).toEqual([{ id: c.id, code: "invalid_transition", message: expect.any(String) }]);
    const tagged = db.select().from(activityEvents).where(eq(activityEvents.eventType, "job.status_changed")).all();
    expect(tagged.map((e) => e.metadata.batchId)).toEqual([tr.batchId, tr.batchId]);
    expectClean();
  });
});

describe("recomputeJobDerived", () => {
  it("repairs tampered pointers from the ledgers and audits each with cause recompute", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "submitted" });
    run((tx) =>
      transitionJobStatus(tx, ctxOf("photographer1"), {
        jobId: job.id,
        toCategory: "revision",
        expectedVersion: job.version,
        revision: { reason: "Colour", description: "Too cold" },
      }),
    );
    expectClean();
    db.$client.prepare("UPDATE jobs SET editor_id = ?, revision_count = 7, open_revision_id = NULL, previous_status_id = NULL WHERE id = ?").run(ids.users.editor2, job.id);
    const drift = verifyDerived(db.$client).drift.map((d) => d.column).sort();
    expect(drift).toEqual(["editor_id", "open_revision_id", "previous_status_id", "revision_count"]);

    expect(catchErr(() => run((tx) => repairJob(tx, ctxOf("manager"), { jobId: job.id }))).status).toBe(403);
    fakeClock.advanceMinutes(5);
    const res = run((tx) => repairJob(tx, ctxOf("owner"), { jobId: job.id }));
    expect(res.changes.map((c) => c.column).sort()).toEqual(["editorId", "openRevisionId", "previousStatusId", "revisionCount"]);
    expectClean();
    const audit = db.select().from(activityEvents).where(and(eq(activityEvents.jobId, job.id), eq(activityEvents.eventType, "job.field_changed"))).orderBy(asc(activityEvents.createdAt)).all();
    expect(audit).toHaveLength(4);
    expect(audit.every((e) => e.metadata.cause === "recompute" && e.actorUserId === ids.users.owner)).toBe(true);
    // idempotent; works without a context (system, cause recompute)
    expect(run((tx) => recomputeJobDerived(tx, job.id)).changes).toEqual([]);
  });
});
