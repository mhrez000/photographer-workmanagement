import { and, asc, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tx } from "@/db/index";
import { activityEvents, jobAssignments, jobRevisions, jobStatusTransitions, jobs, notifications, workSessions } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type FixtureUserKey, type SeedIds, type TestDb } from "@/db/test-db";
import { verifyDerived } from "@/db/verify";
import type { Job } from "@/lib/types";
import { AppError } from "@/server/errors";
import { withTx } from "./_shared";
import { assignEditor, assignPhotographer, assignRole, bulkReassign, unassignEditor } from "./assignments";
import { startTimer } from "./timeTracking";
import { transitionJobStatus } from "./workflow";

let db: TestDb;
let ids: SeedIds;

beforeEach(() => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = makeTestDb();
  ids = seedMinimalOrg(db, { settings: { timeTrackingEnabled: true } });
});
afterEach(() => fakeClock.reset());

const ctxOf = (key: FixtureUserKey) => contextFor(db, ids.users[key]);
const run = <T>(fn: (tx: Tx) => T): T => withTx(fn, { db });
const jobRow = (id: string): Job => db.select().from(jobs).where(eq(jobs.id, id)).get() as Job;
const transitionsOf = (jobId: string) =>
  db.select().from(jobStatusTransitions).where(eq(jobStatusTransitions.jobId, jobId)).orderBy(asc(jobStatusTransitions.sequence)).all();
const editorAssignments = (jobId: string) =>
  db.select().from(jobAssignments).where(and(eq(jobAssignments.jobId, jobId), eq(jobAssignments.role, "editor"))).orderBy(asc(jobAssignments.assignedAt)).all();
const notificationsOf = (type: string) => db.select().from(notifications).where(eq(notifications.type, type as never)).all();
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
function assign(actor: FixtureUserKey, jobId: string, userId: string | null, extra: Record<string, unknown> = {}) {
  return run((tx) => assignEditor(tx, ctxOf(actor), { jobId, userId, expectedVersion: jobRow(jobId).version, ...extra }));
}

describe("assignEditor status handling (§4.5)", () => {
  it("new → assigned: assignment row, transition into assigned, job_assigned notice", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "new" });
    const res = assign("photographer1", job.id, ids.users.editor1, { reason: "Best for twilight" });
    expect(res.changed).toBe(true);
    expect(res.transition?.toStatus.category).toBe("assigned");
    expect(jobRow(job.id)).toMatchObject({ editorId: ids.users.editor1, statusCategory: "assigned" });
    expect(transitionsOf(job.id).at(-1)).toMatchObject({ editorIdAtEntry: ids.users.editor1, kind: "transition" });
    const rows = editorAssignments(job.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: ids.users.editor1, reason: "Best for twilight", statusCategoryAtAssign: "new" });
    expect(rows[0].activityEventId).not.toBeNull();
    expect(notificationsOf("job_assigned").map((n) => n.userId)).toEqual([ids.users.editor1]);
    expectClean();
  });

  it("assigned → still assigned with the stage re-attributed; accepted → back to assigned", () => {
    const a = insertJobFixture(db, ids, { statusKey: "assigned" }).job;
    const resA = assign("manager", a.id, ids.users.editor2);
    expect(resA.reattribution).not.toBeNull();
    expect(jobRow(a.id).statusCategory).toBe("assigned");
    expect(transitionsOf(a.id).at(-1)).toMatchObject({ kind: "reattribution", editorIdAtEntry: ids.users.editor2 });

    const b = insertJobFixture(db, ids, { statusKey: "accepted" }).job;
    const resB = assign("manager", b.id, ids.users.editor2);
    expect(resB.transition?.toStatus.category).toBe("assigned");
    expect(jobRow(b.id)).toMatchObject({ statusCategory: "assigned", editorId: ids.users.editor2, previousEditorId: ids.users.editor1 });
    expect(notificationsOf("job_reassigned").map((n) => n.userId)).toEqual([ids.users.editor1, ids.users.editor1]);
    expectClean();
  });

  it("mid in_progress: status unchanged, reattribution row, old session closed, old editor read-only", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress" });
    run((tx) => startTimer(tx, ctxOf("editor1"), { jobId: job.id }));
    fakeClock.advanceHours(2);
    const res = assign("manager", job.id, ids.users.editor2, { reason: "Workload balancing" });
    const after = jobRow(job.id);
    expect(after).toMatchObject({ statusId: ids.statuses.in_progress, editorId: ids.users.editor2, previousEditorId: ids.users.editor1 });
    const rows = transitionsOf(job.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ editorIdAtEntry: ids.users.editor1, durationSeconds: 7200 });
    expect(rows[1]).toMatchObject({
      kind: "reattribution",
      fromStatusId: rows[0].fromStatusId,
      toStatusId: ids.statuses.in_progress,
      editorIdAtEntry: ids.users.editor2,
      reason: "reassigned",
      activityEventId: res.reattribution?.eventId,
    });
    expect(after.statusEnteredAt).toBe(rows[1].enteredAt);
    const session = db.select().from(workSessions).get();
    expect(session).toMatchObject({ endReason: "auto_reassigned", durationSeconds: 7200 });
    const evt = db.select().from(activityEvents).where(eq(activityEvents.eventType, "job.stage_reattributed")).get();
    expect(evt?.metadata).toMatchObject({ transitionId: rows[1].id, previousTransitionId: rows[0].id, category: "in_progress" });
    expect(editorAssignments(job.id)[0]).toMatchObject({ unassignReason: "reassigned" });
    // old editor keeps read-only visibility (past) but can no longer act
    const err = catchErr(() =>
      run((tx) => transitionJobStatus(tx, ctxOf("editor1"), { jobId: job.id, toCategory: "submitted", expectedVersion: jobRow(job.id).version })),
    );
    expect(err.status).toBe(403);
    expectClean();
  });

  it("in revision: the open revision's assignee follows the new editor", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "submitted" });
    run((tx) =>
      transitionJobStatus(tx, ctxOf("photographer1"), {
        jobId: job.id,
        toCategory: "revision",
        expectedVersion: job.version,
        revision: { reason: "Cropping", description: "Straighten verticals" },
      }),
    );
    assign("manager", job.id, ids.users.editor2);
    const rev = db.select().from(jobRevisions).where(eq(jobRevisions.jobId, job.id)).get();
    expect(rev?.assigneeUserId).toBe(ids.users.editor2);
    expect(transitionsOf(job.id).at(-1)).toMatchObject({ kind: "reattribution", toCategory: "revision" });
    expectClean();
  });

  it("unassign while editor-held → Ready; job_unassigned to the old editor", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress" });
    const res = run((tx) => unassignEditor(tx, ctxOf("manager"), { jobId: job.id, expectedVersion: job.version, reason: "Re-plan" }));
    expect(res.transition?.toStatus.category).toBe("ready");
    expect(jobRow(job.id)).toMatchObject({ editorId: null, previousEditorId: ids.users.editor1, statusCategory: "ready" });
    expect(editorAssignments(job.id)[0]).toMatchObject({ unassignReason: "unassigned" });
    expect(notificationsOf("job_unassigned").map((n) => n.userId)).toEqual([ids.users.editor1]);
    expectClean();
  });

  it("deactivation-style call (no expectedVersion, reason user_deactivated) records that unassign reason", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "accepted" });
    run((tx) => unassignEditor(tx, ctxOf("owner"), { jobId: job.id, userId: null, reason: "user_deactivated" }));
    expect(editorAssignments(job.id)[0]).toMatchObject({ unassignReason: "user_deactivated" });
    const other = insertJobFixture(db, ids, { statusKey: "in_progress" }).job;
    run((tx) => assignEditor(tx, ctxOf("owner"), { jobId: other.id, userId: ids.users.editor2, reason: "user_deactivated" }));
    expect(editorAssignments(other.id)[0]).toMatchObject({ unassignReason: "user_deactivated" });
    expectClean();
  });

  it("approved/completed: ledger swap only, no status change", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "completed" });
    const res = assign("manager", job.id, ids.users.editor2);
    expect(res.transition).toBeNull();
    expect(res.reattribution).toBeNull();
    expect(transitionsOf(job.id)).toHaveLength(1);
    expect(jobRow(job.id).editorId).toBe(ids.users.editor2);
    expectClean();
  });
});

describe("assignEditor validation & permissions", () => {
  it("rejects inactive, non-editor and foreign targets", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "ready" });
    expect(catchErr(() => assign("manager", job.id, ids.users.inactiveEditor)).status).toBe(400);
    expect(catchErr(() => assign("manager", job.id, ids.users.photographer2)).status).toBe(400);
    const other = seedMinimalOrg(db, { slug: "other" });
    expect(catchErr(() => assign("manager", job.id, other.users.editor1)).status).toBe(404);
    expect(jobRow(job.id).editorId).toBeNull();
  });

  it("editors cannot assign; photographers only on their own jobs; cancelled jobs refused; stale version 409", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "assigned" });
    expect(catchErr(() => assign("editor1", job.id, ids.users.editor2)).status).toBe(403);
    expect(catchErr(() => assign("photographer2", job.id, ids.users.editor2)).status).toBe(404);
    expect(catchErr(() => run((tx) => assignEditor(tx, ctxOf("manager"), { jobId: job.id, userId: ids.users.editor2, expectedVersion: 99 }))).status).toBe(409);
    const cancelled = insertJobFixture(db, ids, { statusKey: "cancelled" }).job;
    expect(catchErr(() => assign("manager", cancelled.id, ids.users.editor2)).status).toBe(400);
  });

  it("re-assigning the current editor is a no-op", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "assigned" });
    const res = assign("manager", job.id, ids.users.editor1);
    expect(res.changed).toBe(false);
    expect(jobRow(job.id).version).toBe(job.version);
  });
});

describe("assignPhotographer", () => {
  it("swaps the photographer ledger and pointer", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "new", createdByUserId: ids.users.manager });
    const res = run((tx) => assignRole(tx, ctxOf("manager"), { role: "photographer", jobId: job.id, userId: ids.users.photographer2, expectedVersion: job.version }));
    expect(res.changed).toBe(true);
    expect(jobRow(job.id).photographerId).toBe(ids.users.photographer2);
    const rows = db.select().from(jobAssignments).where(and(eq(jobAssignments.jobId, job.id), eq(jobAssignments.role, "photographer"))).all();
    expect(rows.filter((r) => r.unassignedAt === null).map((r) => r.userId)).toEqual([ids.users.photographer2]);
    expect(catchErr(() => run((tx) => assignPhotographer(tx, ctxOf("manager"), { jobId: job.id, userId: ids.users.editor1 }))).status).toBe(400);
    expectClean();
  });
});

describe("bulkReassign", () => {
  it("one transaction per job, partial failures reported, events tagged with the batchId", () => {
    const ok1 = insertJobFixture(db, ids, { statusKey: "in_progress" }).job;
    const ok2 = insertJobFixture(db, ids, { statusKey: "new" }).job;
    const cancelled = insertJobFixture(db, ids, { statusKey: "cancelled" }).job;
    const other = seedMinimalOrg(db, { slug: "other" });
    const foreign = insertJobFixture(db, other, { statusKey: "new" }).job;
    expect(catchErr(() => bulkReassign(ctxOf("photographer1"), { jobIds: [ok1.id], userId: ids.users.editor2 }, { db })).status).toBe(403);

    const res = bulkReassign(ctxOf("manager"), { jobIds: [ok1.id, ok2.id, cancelled.id, foreign.id, ok1.id], userId: ids.users.editor2 }, { db });
    expect(res.ok).toEqual([ok1.id, ok2.id]);
    expect(res.failed).toEqual([
      { id: cancelled.id, code: "validation", message: expect.any(String) },
      { id: foreign.id, code: "not_found", message: "Job not found" },
    ]);
    expect(res.batchId).toMatch(/\S+/);
    const tagged = db.select().from(activityEvents).where(eq(activityEvents.eventType, "assignment.created")).all();
    expect(tagged.every((e) => e.metadata.batchId === res.batchId)).toBe(true);
    expect(jobRow(foreign.id).editorId).toBeNull();
    expect(db.select().from(jobAssignments).where(and(eq(jobAssignments.jobId, cancelled.id), isNull(jobAssignments.unassignedAt))).all()).toHaveLength(1);
    expectClean();
  });
});
