import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first, type Tx } from "@/db/index";
import { activityEvents, jobNotes, jobRevisions, jobStatusTransitions, jobs, notifications } from "@/db/schema";
import { contextFor, fakeClock, insertJobFixture, makeTestDb, seedMinimalOrg, type FixtureUserKey, type SeedIds, type TestDb } from "@/db/test-db";
import { verifyDerived } from "@/db/verify";
import type { AuthContext, Job } from "@/lib/types";
import { AppError } from "@/server/errors";
import { withTx } from "./_shared";
import { requestRevision, resolveRevision, updateRevision, withdrawRevision } from "./revisions";
import { transitionJobStatus } from "./workflow";

let db: TestDb;
let ids: SeedIds;

beforeEach(async () => {
  fakeClock.set("2026-10-08T00:00:00.000Z");
  db = await makeTestDb();
  ids = await seedMinimalOrg(db);
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
const versionOf = async (id: string): Promise<number> => (await jobRow(id)).version;
const revisionsOf = (jobId: string) => db.select().from(jobRevisions).where(eq(jobRevisions.jobId, jobId)).orderBy(asc(jobRevisions.revisionNumber));
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
const payload = { reason: "Colour", description: "Kitchen too cold", instructions: "Match the reference warmth", priority: "high" as const, dueDate: "2026-10-09" };
async function request(actor: FixtureUserKey, jobId: string, extra: Record<string, unknown> = {}) {
  const expectedVersion = await versionOf(jobId);
  return as(actor, (tx, ctx) => requestRevision(tx, ctx, { jobId, expectedVersion, ...payload, ...extra }));
}


describe("requestRevision", () => {
  it("creates revision #1 with its note, event and mandatory notification", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "submitted" });
    const res = await request("photographer1", job.id);
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
    expect(await jobRow(job.id)).toMatchObject({ revisionCount: 1, openRevisionId: res.revision.id });
    const note = await first(db.select().from(jobNotes).where(eq(jobNotes.jobId, job.id)));
    expect(note).toMatchObject({ kind: "revision", body: payload.instructions, revisionId: res.revision.id });
    const evt = await first(db.select().from(activityEvents).where(eq(activityEvents.eventType, "revision.requested")));
    expect(evt?.metadata).toMatchObject({ revisionId: res.revision.id, transitionId: res.transitionId, revisionNumber: 1 });
    expect(res.revision.activityEventId).toBe(evt?.id);
    expect((await db.select().from(notifications).where(eq(notifications.type, "revision_requested"))).map((n) => n.userId)).toEqual([ids.users.editor1]);
    await expectClean();
  });

  it("a transition into revision without a payload is a 400", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "review" });
    const err = await catchErr(as("coAdmin", (tx, ctx) => transitionJobStatus(tx, ctx, { jobId: job.id, toCategory: "revision", expectedVersion: job.version })));
    expect(err.status).toBe(400);
    expect((await jobRow(job.id)).statusCategory).toBe("review");
  });

  it("naming another editor reassigns the job first (same transaction)", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "submitted" });
    const res = await request("coAdmin", job.id, { assigneeUserId: ids.users.editor2 });
    expect(res.revision.assigneeUserId).toBe(ids.users.editor2);
    expect(await jobRow(job.id)).toMatchObject({ editorId: ids.users.editor2, previousEditorId: ids.users.editor1 });
    const last = await first(db.select().from(jobStatusTransitions).where(eq(jobStatusTransitions.id, res.transitionId)));
    expect(last?.editorIdAtEntry).toBe(ids.users.editor2);
    const another = (await insertJobFixture(db, ids, { statusKey: "submitted" })).job;
    expect((await catchErr(request("coAdmin", another.id, { assigneeUserId: ids.users.inactiveEditor }))).status).toBe(422);
    await expectClean();
  });

  it("permissions: editors cannot request; other photographers cannot see the job", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "submitted" });
    expect((await catchErr(request("editor1", job.id))).status).toBe(403);
    expect((await catchErr(request("photographer2", job.id))).status).toBe(404);
  });
});

describe("numbering, resolve, withdraw", () => {
  it("revision numbers are never reused (withdrawn ones still count)", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "submitted" });
    const r1 = await request("photographer1", job.id);
    fakeClock.advanceHours(3);
    let expectedVersion = await versionOf(job.id);
    const resolved = await as("editor1", (tx, ctx) => resolveRevision(tx, ctx, { revisionId: r1.revision.id, expectedVersion, note: "Warmer now" }));
    expect(resolved.toStatus.category).toBe("resubmitted");
    expect(resolved.revision).toMatchObject({ resolution: "resubmitted", resolutionNote: "Warmer now", resolvedByUserId: ids.users.editor1, resolveTransitionId: resolved.transitionId });
    expect((await jobRow(job.id)).openRevisionId).toBeNull();
    const submittedEvt = await first(db.select().from(activityEvents).where(eq(activityEvents.eventType, "job.submitted")));
    expect(submittedEvt?.metadata).toMatchObject({ resubmission: true, revisionNumber: 1 });

    const r2 = await request("photographer1", job.id);
    expect(r2.revision.revisionNumber).toBe(2);
    expectedVersion = await versionOf(job.id);
    const withdrawn = await as("photographer1", (tx, ctx) => withdrawRevision(tx, ctx, { revisionId: r2.revision.id, expectedVersion, note: "My mistake" }));
    expect("toStatus" in withdrawn && withdrawn.toStatus.category).toBe("resubmitted");
    expect(withdrawn.revision).toMatchObject({ resolution: "withdrawn", resolutionNote: "My mistake" });
    expect(await jobRow(job.id)).toMatchObject({ statusId: ids.statuses.resubmitted, openRevisionId: null, revisionCount: 2 });
    expect(await db.select().from(activityEvents).where(eq(activityEvents.eventType, "revision.withdrawn"))).toHaveLength(1);

    const r3 = await request("photographer1", job.id);
    expect(r3.revision.revisionNumber).toBe(3);
    expect((await revisionsOf(job.id)).map((r) => r.revisionNumber)).toEqual([1, 2, 3]);
    await expectClean();
  });

  it("resolve requires the job to be in revision and the revision open", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "submitted" });
    const r1 = await request("photographer1", job.id);
    let expectedVersion = await versionOf(job.id);
    expect((await catchErr(as("editor2", (tx, ctx) => resolveRevision(tx, ctx, { revisionId: r1.revision.id, expectedVersion })))).status).toBe(404);
    await as("editor1", (tx, ctx) => resolveRevision(tx, ctx, { revisionId: r1.revision.id, expectedVersion }));
    expectedVersion = await versionOf(job.id);
    expect((await catchErr(as("editor1", (tx, ctx) => resolveRevision(tx, ctx, { revisionId: r1.revision.id, expectedVersion })))).status).toBe(400);
  });

  it("approving over an open revision (override) resolves it as approved", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "submitted" });
    const r1 = await request("photographer1", job.id);
    const expectedVersion = await versionOf(job.id);
    await as("coAdmin", (tx, ctx) => transitionJobStatus(tx, ctx, { jobId: job.id, toCategory: "approved", expectedVersion, override: true, reason: "Client accepted as-is" }));
    expect((await revisionsOf(job.id))[0]).toMatchObject({ id: r1.revision.id, resolution: "approved" });
    expect((await jobRow(job.id)).openRevisionId).toBeNull();
    await expectClean();
  });
});

describe("updateRevision", () => {
  it("edits assignee / instructions / priority / due date while open; closed revisions are frozen", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "submitted" });
    const r1 = await request("photographer1", job.id);
    const res = await as("photographer1", (tx, ctx) =>
      updateRevision(tx, ctx, { revisionId: r1.revision.id, assigneeUserId: ids.users.editor2, priority: "urgent", instructions: "", dueDate: "2026-10-11" }),
    );
    expect(res.changed.sort()).toEqual(["assigneeUserId", "dueDate", "instructions", "priority"]);
    expect(res.revision).toMatchObject({ assigneeUserId: ids.users.editor2, priority: "urgent", instructions: null, dueDate: "2026-10-11T12:59:59.999Z" });
    // A new assignee takes over the JOB (§4.4): the re-point is audited by the
    // assignment hand-over, the other fields by this update.
    expect(await jobRow(job.id)).toMatchObject({ editorId: ids.users.editor2, previousEditorId: ids.users.editor1 });
    const evts = await db
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.eventType, "revision.updated"), eq(activityEvents.entityId, r1.revision.id)))
      .orderBy(asc(activityEvents.createdAt), asc(activityEvents.rowid));
    expect(evts.find((e) => (e.metadata as Record<string, unknown>).reassigned === true)?.previousValue).toEqual({ assigneeUserId: ids.users.editor1 });
    expect(evts.at(-1)?.previousValue).toMatchObject({ priority: "high" });
    expect((await catchErr(as("editor1", (tx, ctx) => updateRevision(tx, ctx, { revisionId: r1.revision.id, priority: "low" })))).status).toBe(403);
    await expectClean();

    const expectedVersion = await versionOf(job.id);
    await as("editor2", (tx, ctx) => resolveRevision(tx, ctx, { revisionId: r1.revision.id, expectedVersion }));
    expect((await catchErr(as("photographer1", (tx, ctx) => updateRevision(tx, ctx, { revisionId: r1.revision.id, priority: "low" })))).status).toBe(400);
  });
});
