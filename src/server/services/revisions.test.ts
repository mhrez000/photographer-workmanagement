import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tx } from "@/db/index";
import { activityEvents, jobNotes, jobRevisions, jobStatusTransitions, jobs, notifications } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type FixtureUserKey, type SeedIds, type TestDb } from "@/db/test-db";
import { verifyDerived } from "@/db/verify";
import type { Job } from "@/lib/types";
import { AppError } from "@/server/errors";
import { withTx } from "./_shared";
import { requestRevision, resolveRevision, updateRevision, withdrawRevision } from "./revisions";
import { transitionJobStatus } from "./workflow";

let db: TestDb;
let ids: SeedIds;

beforeEach(() => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = makeTestDb();
  ids = seedMinimalOrg(db);
});
afterEach(() => fakeClock.reset());

const ctxOf = (key: FixtureUserKey) => contextFor(db, ids.users[key]);
const run = <T>(fn: (tx: Tx) => T): T => withTx(fn, { db });
const jobRow = (id: string): Job => db.select().from(jobs).where(eq(jobs.id, id)).get() as Job;
const revisionsOf = (jobId: string) => db.select().from(jobRevisions).where(eq(jobRevisions.jobId, jobId)).orderBy(asc(jobRevisions.revisionNumber)).all();
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
const payload = { reason: "Colour", description: "Kitchen too cold", instructions: "Match the reference warmth", priority: "high" as const, dueDate: "2026-10-09" };
const request = (actor: FixtureUserKey, jobId: string, extra: Record<string, unknown> = {}) =>
  run((tx) => requestRevision(tx, ctxOf(actor), { jobId, expectedVersion: jobRow(jobId).version, ...payload, ...extra }));

describe("requestRevision", () => {
  it("creates revision #1 with its note, event and mandatory notification", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "submitted" });
    const res = request("photographer1", job.id);
    expect(res.toStatus.category).toBe("revision");
    expect(res.revision).toMatchObject({
      revisionNumber: 1,
      assigneeUserId: ids.users.editor1,
      requestedByUserId: ids.users.photographer1,
      priority: "high",
      dueDate: "2026-10-09T12:59:59.999Z",
      requestTransitionId: res.transitionId,
      resolvedAt: null,
    });
    expect(jobRow(job.id)).toMatchObject({ revisionCount: 1, openRevisionId: res.revision.id });
    const note = db.select().from(jobNotes).where(eq(jobNotes.jobId, job.id)).get();
    expect(note).toMatchObject({ kind: "revision", body: payload.instructions, revisionId: res.revision.id });
    const evt = db.select().from(activityEvents).where(eq(activityEvents.eventType, "revision.requested")).get();
    expect(evt?.metadata).toMatchObject({ revisionId: res.revision.id, transitionId: res.transitionId, revisionNumber: 1 });
    expect(res.revision.activityEventId).toBe(evt?.id);
    expect(db.select().from(notifications).where(eq(notifications.type, "revision_requested")).all().map((n) => n.userId)).toEqual([ids.users.editor1]);
    expectClean();
  });

  it("a transition into revision without a payload is a 400", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "review" });
    const err = catchErr(() => run((tx) => transitionJobStatus(tx, ctxOf("manager"), { jobId: job.id, toCategory: "revision", expectedVersion: job.version })));
    expect(err.status).toBe(400);
    expect(jobRow(job.id).statusCategory).toBe("review");
  });

  it("naming another editor reassigns the job first (same transaction)", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "submitted" });
    const res = request("manager", job.id, { assigneeUserId: ids.users.editor2 });
    expect(res.revision.assigneeUserId).toBe(ids.users.editor2);
    expect(jobRow(job.id)).toMatchObject({ editorId: ids.users.editor2, previousEditorId: ids.users.editor1 });
    const last = db.select().from(jobStatusTransitions).where(eq(jobStatusTransitions.id, res.transitionId)).get();
    expect(last?.editorIdAtEntry).toBe(ids.users.editor2);
    expect(catchErr(() => request("manager", insertJobFixture(db, ids, { statusKey: "submitted" }).job.id, { assigneeUserId: ids.users.inactiveEditor })).status).toBe(400);
    expectClean();
  });

  it("permissions: editors cannot request; other photographers cannot see the job", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "submitted" });
    expect(catchErr(() => request("editor1", job.id)).status).toBe(403);
    expect(catchErr(() => request("photographer2", job.id)).status).toBe(404);
  });
});

describe("numbering, resolve, withdraw", () => {
  it("revision numbers are never reused (withdrawn ones still count)", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "submitted" });
    const r1 = request("photographer1", job.id);
    fakeClock.advanceHours(3);
    const resolved = run((tx) => resolveRevision(tx, ctxOf("editor1"), { revisionId: r1.revision.id, expectedVersion: jobRow(job.id).version, note: "Warmer now" }));
    expect(resolved.toStatus.category).toBe("resubmitted");
    expect(resolved.revision).toMatchObject({ resolution: "resubmitted", resolutionNote: "Warmer now", resolvedByUserId: ids.users.editor1, resolveTransitionId: resolved.transitionId });
    expect(jobRow(job.id).openRevisionId).toBeNull();
    const submittedEvt = db.select().from(activityEvents).where(eq(activityEvents.eventType, "job.submitted")).get();
    expect(submittedEvt?.metadata).toMatchObject({ resubmission: true, revisionNumber: 1 });

    const r2 = request("photographer1", job.id);
    expect(r2.revision.revisionNumber).toBe(2);
    const withdrawn = run((tx) => withdrawRevision(tx, ctxOf("photographer1"), { revisionId: r2.revision.id, expectedVersion: jobRow(job.id).version, note: "My mistake" }));
    expect("toStatus" in withdrawn && withdrawn.toStatus.category).toBe("resubmitted");
    expect(withdrawn.revision).toMatchObject({ resolution: "withdrawn", resolutionNote: "My mistake" });
    expect(jobRow(job.id)).toMatchObject({ statusId: ids.statuses.resubmitted, openRevisionId: null, revisionCount: 2 });
    expect(db.select().from(activityEvents).where(eq(activityEvents.eventType, "revision.withdrawn")).all()).toHaveLength(1);

    const r3 = request("photographer1", job.id);
    expect(r3.revision.revisionNumber).toBe(3);
    expect(revisionsOf(job.id).map((r) => r.revisionNumber)).toEqual([1, 2, 3]);
    expectClean();
  });

  it("resolve requires the job to be in revision and the revision open", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "submitted" });
    const r1 = request("photographer1", job.id);
    expect(catchErr(() => run((tx) => resolveRevision(tx, ctxOf("editor2"), { revisionId: r1.revision.id, expectedVersion: jobRow(job.id).version }))).status).toBe(404);
    run((tx) => resolveRevision(tx, ctxOf("editor1"), { revisionId: r1.revision.id, expectedVersion: jobRow(job.id).version }));
    expect(catchErr(() => run((tx) => resolveRevision(tx, ctxOf("editor1"), { revisionId: r1.revision.id, expectedVersion: jobRow(job.id).version }))).status).toBe(400);
  });

  it("approving over an open revision (override) resolves it as approved", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "submitted" });
    const r1 = request("photographer1", job.id);
    run((tx) => transitionJobStatus(tx, ctxOf("manager"), { jobId: job.id, toCategory: "approved", expectedVersion: jobRow(job.id).version, override: true, reason: "Client accepted as-is" }));
    expect(revisionsOf(job.id)[0]).toMatchObject({ id: r1.revision.id, resolution: "approved" });
    expect(jobRow(job.id).openRevisionId).toBeNull();
    expectClean();
  });
});

describe("updateRevision", () => {
  it("edits assignee / instructions / priority / due date while open; closed revisions are frozen", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "submitted" });
    const r1 = request("photographer1", job.id);
    const res = run((tx) =>
      updateRevision(tx, ctxOf("photographer1"), { revisionId: r1.revision.id, assigneeUserId: ids.users.editor2, priority: "urgent", instructions: "", dueDate: "2026-10-11" }),
    );
    expect(res.changed.sort()).toEqual(["assigneeUserId", "dueDate", "instructions", "priority"]);
    expect(res.revision).toMatchObject({ assigneeUserId: ids.users.editor2, priority: "urgent", instructions: null, dueDate: "2026-10-11T12:59:59.999Z" });
    // A new assignee takes over the JOB (§4.4): the re-point is audited by the
    // assignment hand-over, the other fields by this update.
    expect(jobRow(job.id)).toMatchObject({ editorId: ids.users.editor2, previousEditorId: ids.users.editor1 });
    const evts = db
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.eventType, "revision.updated"), eq(activityEvents.entityId, r1.revision.id)))
      .all();
    expect(evts.find((e) => (e.metadata as Record<string, unknown>).reassigned === true)?.previousValue).toEqual({ assigneeUserId: ids.users.editor1 });
    expect(evts.at(-1)?.previousValue).toMatchObject({ priority: "high" });
    expect(catchErr(() => run((tx) => updateRevision(tx, ctxOf("editor1"), { revisionId: r1.revision.id, priority: "low" }))).status).toBe(403);
    expectClean();

    run((tx) => resolveRevision(tx, ctxOf("editor2"), { revisionId: r1.revision.id, expectedVersion: jobRow(job.id).version }));
    expect(catchErr(() => run((tx) => updateRevision(tx, ctxOf("photographer1"), { revisionId: r1.revision.id, priority: "low" }))).status).toBe(400);
  });
});
