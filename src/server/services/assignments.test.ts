import { and, asc, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first, type Tx } from "@/db/index";
import { activityEvents, jobAssignments, jobRevisions, jobStatusTransitions, jobs, notifications, workSessions } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, setUserFlags, type FixtureUserKey, type SeedIds, type TestDb } from "@/db/test-db";
import { verifyDerived } from "@/db/verify";
import type { AuthContext, Job } from "@/lib/types";
import { AppError } from "@/server/errors";
import { withTx } from "./_shared";
import { assignEditor, assignPhotographer, assignRole, bulkReassign, unassignEditor } from "./assignments";
import { startTimer } from "./timeTracking";
import { transitionJobStatus } from "./workflow";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
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
const transitionsOf = (jobId: string) =>
  db.select().from(jobStatusTransitions).where(eq(jobStatusTransitions.jobId, jobId)).orderBy(asc(jobStatusTransitions.sequence));
const editorAssignments = (jobId: string) =>
  db
    .select()
    .from(jobAssignments)
    .where(and(eq(jobAssignments.jobId, jobId), eq(jobAssignments.role, "editor")))
    .orderBy(asc(jobAssignments.assignedAt), asc(jobAssignments.rowid));
const notificationsOf = (type: string) => db.select().from(notifications).where(eq(notifications.type, type as never));
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
async function assign(actor: FixtureUserKey, jobId: string, userId: string | null, extra: Record<string, unknown> = {}) {
  const expectedVersion = (await jobRow(jobId)).version;
  return as(actor, (tx, ctx) => assignEditor(tx, ctx, { jobId, userId, expectedVersion, ...extra }));
}

describe("assignEditor status handling (§4.5)", () => {
  it("new → assigned: assignment row, transition into assigned, job_assigned notice", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "new" });
    const res = await assign("photographer1", job.id, ids.users.editor1, { reason: "Best for twilight" });
    expect(res.changed).toBe(true);
    expect(res.transition?.toStatus.category).toBe("assigned");
    expect(await jobRow(job.id)).toMatchObject({ editorId: ids.users.editor1, statusCategory: "assigned" });
    expect((await transitionsOf(job.id)).at(-1)).toMatchObject({ editorIdAtEntry: ids.users.editor1, kind: "transition" });
    const rows = await editorAssignments(job.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: ids.users.editor1, reason: "Best for twilight", statusCategoryAtAssign: "new" });
    expect(rows[0].activityEventId).not.toBeNull();
    expect((await notificationsOf("job_assigned")).map((n) => n.userId)).toEqual([ids.users.editor1]);
    await expectClean();
  });

  it("assigned → still assigned with the stage re-attributed; accepted → back to assigned", async () => {
    const a = (await insertJobFixture(db, ids, { statusKey: "assigned" })).job;
    const resA = await assign("coAdmin", a.id, ids.users.editor2);
    expect(resA.reattribution).not.toBeNull();
    expect((await jobRow(a.id)).statusCategory).toBe("assigned");
    expect((await transitionsOf(a.id)).at(-1)).toMatchObject({ kind: "reattribution", editorIdAtEntry: ids.users.editor2 });

    const b = (await insertJobFixture(db, ids, { statusKey: "accepted" })).job;
    const resB = await assign("coAdmin", b.id, ids.users.editor2);
    expect(resB.transition?.toStatus.category).toBe("assigned");
    expect(await jobRow(b.id)).toMatchObject({ statusCategory: "assigned", editorId: ids.users.editor2, previousEditorId: ids.users.editor1 });
    expect((await notificationsOf("job_reassigned")).map((n) => n.userId)).toEqual([ids.users.editor1, ids.users.editor1]);
    await expectClean();
  });

  it("mid in_progress: status unchanged, reattribution row, old session closed, old editor read-only", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    await as("editor1", (tx, ctx) => startTimer(tx, ctx, { jobId: job.id }));
    fakeClock.advanceHours(2);
    const res = await assign("coAdmin", job.id, ids.users.editor2, { reason: "Workload balancing" });
    const after = await jobRow(job.id);
    expect(after).toMatchObject({ statusId: ids.statuses.in_progress, editorId: ids.users.editor2, previousEditorId: ids.users.editor1 });
    const rows = await transitionsOf(job.id);
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
    const session = await first(db.select().from(workSessions));
    expect(session).toMatchObject({ endReason: "auto_reassigned", durationSeconds: 7200 });
    const evt = await first(db.select().from(activityEvents).where(eq(activityEvents.eventType, "job.stage_reattributed")));
    expect(evt?.metadata).toMatchObject({ transitionId: rows[1].id, previousTransitionId: rows[0].id, category: "in_progress" });
    expect((await editorAssignments(job.id))[0]).toMatchObject({ unassignReason: "reassigned" });
    // old editor keeps read-only visibility (past) but can no longer act
    const expectedVersion = (await jobRow(job.id)).version;
    const err = await catchErr(as("editor1", (tx, ctx) => transitionJobStatus(tx, ctx, { jobId: job.id, toCategory: "submitted", expectedVersion })));
    expect(err.status).toBe(403);
    await expectClean();
  });

  it("in revision: the open revision's assignee follows the new editor", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "submitted" });
    await as("photographer1", (tx, ctx) =>
      transitionJobStatus(tx, ctx, {
        jobId: job.id,
        toCategory: "revision",
        expectedVersion: job.version,
        revision: { reason: "Cropping", description: "Straighten verticals" },
      }),
    );
    await assign("coAdmin", job.id, ids.users.editor2);
    const rev = await first(db.select().from(jobRevisions).where(eq(jobRevisions.jobId, job.id)));
    expect(rev?.assigneeUserId).toBe(ids.users.editor2);
    expect((await transitionsOf(job.id)).at(-1)).toMatchObject({ kind: "reattribution", toCategory: "revision" });
    await expectClean();
  });

  it("unassign while editor-held → Ready; job_unassigned to the old editor", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    const res = await as("coAdmin", (tx, ctx) => unassignEditor(tx, ctx, { jobId: job.id, expectedVersion: job.version, reason: "Re-plan" }));
    expect(res.transition?.toStatus.category).toBe("ready");
    expect(await jobRow(job.id)).toMatchObject({ editorId: null, previousEditorId: ids.users.editor1, statusCategory: "ready" });
    expect((await editorAssignments(job.id))[0]).toMatchObject({ unassignReason: "unassigned" });
    expect((await notificationsOf("job_unassigned")).map((n) => n.userId)).toEqual([ids.users.editor1]);
    await expectClean();
  });

  it("deactivation-style call (no expectedVersion, reason user_deactivated) records that unassign reason", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "accepted" });
    await as("owner", (tx, ctx) => unassignEditor(tx, ctx, { jobId: job.id, userId: null, reason: "user_deactivated" }));
    expect((await editorAssignments(job.id))[0]).toMatchObject({ unassignReason: "user_deactivated" });
    const other = (await insertJobFixture(db, ids, { statusKey: "in_progress" })).job;
    await as("owner", (tx, ctx) => assignEditor(tx, ctx, { jobId: other.id, userId: ids.users.editor2, reason: "user_deactivated" }));
    expect((await editorAssignments(other.id))[0]).toMatchObject({ unassignReason: "user_deactivated" });
    await expectClean();
  });

  it("approved/completed: ledger swap only, no status change", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "completed" });
    const res = await assign("coAdmin", job.id, ids.users.editor2);
    expect(res.transition).toBeNull();
    expect(res.reattribution).toBeNull();
    expect(await transitionsOf(job.id)).toHaveLength(1);
    expect((await jobRow(job.id)).editorId).toBe(ids.users.editor2);
    await expectClean();
  });
});

describe("assignEditor validation & permissions", () => {
  it("rejects inactive, non-editor and foreign targets", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "ready" });
    expect((await catchErr(assign("coAdmin", job.id, ids.users.inactiveEditor))).status).toBe(422);
    expect((await catchErr(assign("coAdmin", job.id, ids.users.photographer2))).status).toBe(422);
    const other = await seedMinimalOrg(db, { slug: "other" });
    expect((await catchErr(assign("coAdmin", job.id, other.users.editor1))).status).toBe(404);
    expect((await jobRow(job.id)).editorId).toBeNull();
  });

  it("editors cannot assign; photographers only on their own jobs; cancelled jobs refused; stale version 409", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "assigned" });
    expect((await catchErr(assign("editor1", job.id, ids.users.editor2))).status).toBe(403);
    expect((await catchErr(assign("photographer2", job.id, ids.users.editor2))).status).toBe(404);
    expect((await catchErr(as("coAdmin", (tx, ctx) => assignEditor(tx, ctx, { jobId: job.id, userId: ids.users.editor2, expectedVersion: 99 })))).status).toBe(409);
    const cancelled = (await insertJobFixture(db, ids, { statusKey: "cancelled" })).job;
    expect((await catchErr(assign("coAdmin", cancelled.id, ids.users.editor2))).status).toBe(400);
  });

  it("re-assigning the current editor is a no-op", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "assigned" });
    const res = await assign("coAdmin", job.id, ids.users.editor1);
    expect(res.changed).toBe(false);
    expect((await jobRow(job.id)).version).toBe(job.version);
  });
});

describe("assignPhotographer", () => {
  it("swaps the photographer ledger and pointer", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "new", createdByUserId: ids.users.coAdmin });
    const res = await as("coAdmin", (tx, ctx) => assignRole(tx, ctx, { role: "photographer", jobId: job.id, userId: ids.users.photographer2, expectedVersion: job.version }));
    expect(res.changed).toBe(true);
    expect((await jobRow(job.id)).photographerId).toBe(ids.users.photographer2);
    const rows = await db.select().from(jobAssignments).where(and(eq(jobAssignments.jobId, job.id), eq(jobAssignments.role, "photographer")));
    expect(rows.filter((r) => r.unassignedAt === null).map((r) => r.userId)).toEqual([ids.users.photographer2]);
    expect((await catchErr(as("coAdmin", (tx, ctx) => assignPhotographer(tx, ctx, { jobId: job.id, userId: ids.users.editor1 })))).status).toBe(422);
    await expectClean();
  });
});

describe("bulkReassign", () => {
  it("one transaction per job, partial failures reported, events tagged with the batchId", async () => {
    const ok1 = (await insertJobFixture(db, ids, { statusKey: "in_progress" })).job;
    const ok2 = (await insertJobFixture(db, ids, { statusKey: "new" })).job;
    const cancelled = (await insertJobFixture(db, ids, { statusKey: "cancelled" })).job;
    const other = await seedMinimalOrg(db, { slug: "other" });
    const foreign = (await insertJobFixture(db, other, { statusKey: "new" })).job;
    expect((await catchErr(bulkReassign(await ctxOf("photographer1"), { jobIds: [ok1.id], userId: ids.users.editor2 }, { db }))).status).toBe(403);

    const res = await bulkReassign(await ctxOf("coAdmin"), { jobIds: [ok1.id, ok2.id, cancelled.id, foreign.id, ok1.id], userId: ids.users.editor2 }, { db });
    expect(res.ok).toEqual([ok1.id, ok2.id]);
    expect(res.failed).toEqual([
      { id: cancelled.id, code: "validation", message: expect.any(String) },
      { id: foreign.id, code: "not_found", message: "Job not found" },
    ]);
    expect(res.batchId).toMatch(/\S+/);
    const tagged = await db.select().from(activityEvents).where(eq(activityEvents.eventType, "assignment.created"));
    expect(tagged.every((e) => e.metadata.batchId === res.batchId)).toBe(true);
    expect((await jobRow(foreign.id)).editorId).toBeNull();
    expect(await db.select().from(jobAssignments).where(and(eq(jobAssignments.jobId, cancelled.id), isNull(jobAssignments.unassignedAt)))).toHaveLength(1);
    await expectClean();
  });
});

describe("roles v2: who may assign (docs/ROLES.md §3.3, §3.4)", () => {
  it("editors never assign editors; members need Assign editors on jobs they manage; admins any", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "ready", editorId: null });
    // an editor cannot see an unassigned job someone else created (404) …
    expect((await catchErr(assign("editor1", job.id, ids.users.editor1))).status).toBe(404);
    // … and cannot reassign the job they hold (403)
    const held = (await insertJobFixture(db, ids, { statusKey: "in_progress" })).job;
    expect((await catchErr(assign("editor1", held.id, ids.users.editor2))).status).toBe(403);
    await setUserFlags(db, ids.users.photographer1, { canAssignEditors: false });
    expect((await catchErr(assign("photographer1", job.id, ids.users.editor1))).status).toBe(403);
    // a member who does not manage the job: invisible → 404
    expect((await catchErr(assign("photographer2", job.id, ids.users.editor1))).status).toBe(404);
    await setUserFlags(db, ids.users.photographer1, { canAssignEditors: true });
    const res = await assign("photographer1", job.id, ids.users.editor1);
    expect(res.job.editorId).toBe(ids.users.editor1);
    // allow-list: a client user or a photographer is never an editor
    expect((await catchErr(assign("owner", job.id, ids.users.client))).status).toBe(422);
    await expectClean();
  });

  it("assignPhotographer: admins any active photographer; members never; editors on their own draft (never to nobody)", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "new", createdByUserId: ids.users.editor1, photographerId: ids.users.owner, editorId: null });
    expect((await catchErr(as("photographer1", (tx, ctx) => assignPhotographer(tx, ctx, { jobId: job.id, userId: ids.users.photographer1 })))).status).toBe(404);
    expect((await catchErr(as("owner", (tx, ctx) => assignPhotographer(tx, ctx, { jobId: job.id, userId: ids.users.client })))).status).toBe(422);
    expect((await catchErr(as("owner", (tx, ctx) => assignPhotographer(tx, ctx, { jobId: job.id, userId: ids.users.editor2 })))).status).toBe(422);
    // the editor-creator's draft window: may change the photographer, not remove it
    const changed = await as("editor1", (tx, ctx) => assignPhotographer(tx, ctx, { jobId: job.id, userId: ids.users.photographer2 }));
    expect(changed.job.photographerId).toBe(ids.users.photographer2);
    expect((await catchErr(as("editor1", (tx, ctx) => assignPhotographer(tx, ctx, { jobId: job.id, userId: null })))).status).toBe(400);
    // a member who manages a job still cannot pick another photographer
    const own = (await insertJobFixture(db, ids, { statusKey: "new", editorId: null })).job;
    expect((await catchErr(as("photographer1", (tx, ctx) => assignPhotographer(tx, ctx, { jobId: own.id, userId: ids.users.photographer2 })))).status).toBe(403);
    await expectClean();
  });
});
