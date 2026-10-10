import { and, asc, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { first, type Tx } from "@/db/index";
import {
  activityEvents,
  jobAssignments,
  jobRevisions,
  jobStatusTransitions,
  jobs,
  notifications,
  users,
  workSessions,
  workflowStatuses,
  workflowTransitions,
} from "@/db/schema";
import {
  contextFor,
  fakeClock,
  insertDefaultWorkflow,
  insertJobFixture,
  makeTestDb,
  seedMinimalOrg,
  systemContextFor,
  type FixtureUserKey,
  type SeedIds,
  type TestDb,
} from "@/db/test-db";
import { verifyDerived } from "@/db/verify";
import { DEFAULT_WORKFLOW_STATUSES, DEFAULT_WORKFLOW_TRANSITIONS, STATUS_CATEGORY_META } from "@/lib/constants";
import type { AuthContext, Job } from "@/lib/types";
import { AppError, ConflictError } from "@/server/errors";
import { withTx } from "./_shared";
import { assignEditor } from "./assignments";
import { startTimer } from "./timeTracking";
import {
  acceptJob,
  approveJob,
  beginReview,
  cancelJob,
  completeJob,
  declineJob,
  deliverJob,
  getAllowedTransitions,
  migrateWorkflow,
  reopenJob,
  restoreJob,
  startJob,
  submitJob,
  transitionJobStatus,
  transitionLoadedJob,
} from "./workflow";

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
async function jobRow(id: string): Promise<Job> {
  const row = await first(db.select().from(jobs).where(eq(jobs.id, id)));
  if (!row) throw new Error("job missing");
  return row;
}
/** Calls a `(tx, ctx, { jobId, expectedVersion, … })` service with the job's CURRENT version. */
async function act<R>(actor: FixtureUserKey, svc: (tx: Tx, ctx: AuthContext, input: unknown) => Promise<R>, jobId: string, extra: Record<string, unknown> = {}): Promise<R> {
  const expectedVersion = (await jobRow(jobId)).version;
  return as(actor, (tx, ctx) => svc(tx, ctx, { jobId, expectedVersion, ...extra }));
}
const transitionsOf = (jobId: string) =>
  db.select().from(jobStatusTransitions).where(eq(jobStatusTransitions.jobId, jobId)).orderBy(asc(jobStatusTransitions.sequence));
const eventsOf = (jobId: string, type?: string) =>
  db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.jobId, jobId), type ? eq(activityEvents.eventType, type) : undefined))
    .orderBy(asc(activityEvents.createdAt), asc(activityEvents.rowid));
const revisionPayload = { reason: "Colour", description: "Warm up the kitchen shots", instructions: "Use the client's reference" };

function move(actor: FixtureUserKey, jobId: string, input: Record<string, unknown>) {
  return act(actor, transitionJobStatus, jobId, input);
}
function moveTo(actor: FixtureUserKey, jobId: string, statusKey: string, extra: Record<string, unknown> = {}) {
  return move(actor, jobId, { toStatusId: ids.statuses[statusKey], ...extra });
}
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

/** roles v2: only → assigned is engine-internal; → ready while an editor holds the job is an unassignment (job.assign_editor). */
const ENGINE_INTERNAL = (_from: string, to: string) => to === "assigned";

describe("default edges (§4.2)", () => {
  for (const def of DEFAULT_WORKFLOW_TRANSITIONS) {
    const internal = ENGINE_INTERNAL(def.from, def.to);
    it(`${def.from} → ${def.to} ${internal ? "is engine-internal (422 via transitionJobStatus)" : "succeeds with its ledger rows"}`, async () => {
      const { job } = await insertJobFixture(db, ids, { statusKey: def.from, dueDate: "2026-10-20T12:59:59.999Z" });
      if (internal) {
        const err = await catchErr(moveTo("coAdmin", job.id, def.to));
        expect(err.status).toBe(422);
        // requiresAssignedEditor edges explain the missing editor first
        expect(["invalid_transition", "editor_required"]).toContain(err.code);
        return;
      }
      const actor: FixtureUserKey = def.assigneeOnly ? "editor1" : "photographer1";
      fakeClock.advanceMinutes(30);
      const result = await moveTo(actor, job.id, def.to, {
        ...(def.isReopen ? { reason: "Client asked for changes" } : {}),
        ...(def.to === "revision" ? { revision: revisionPayload } : {}),
      });
      const after = await jobRow(job.id);
      expect(after.statusId).toBe(ids.statuses[def.to]);
      expect(after.statusCategory).toBe(def.to);
      expect(after.previousStatusId).toBe(ids.statuses[def.from]);
      expect(after.version).toBeGreaterThan(job.version);
      const rows = await transitionsOf(job.id);
      expect(rows.filter((r) => r.exitedAt === null)).toHaveLength(1);
      const last = rows[rows.length - 1];
      expect(last).toMatchObject({ id: result.transitionId, kind: "transition", toStatusId: ids.statuses[def.to], isReopen: def.isReopen ?? false });
      expect(rows[0].durationSeconds).toBe(1800);
      expect(last.activityEventId).toBe(result.eventId);
      const evt = (await eventsOf(job.id, "job.status_changed"))[0];
      expect(evt.metadata.transitionId).toBe(result.transitionId);
      await expectClean();
    });
  }

  for (const s of DEFAULT_WORKFLOW_STATUSES.filter((x) => STATUS_CATEGORY_META[x.category].open)) {
    it(`${s.key} → cancelled (generated edge) closes the stage and stamps cancelled_at`, async () => {
      const { job } = await insertJobFixture(db, ids, { statusKey: s.key });
      const err = await catchErr(moveTo("photographer1", job.id, "cancelled"));
      expect(err.status).toBe(400); // reason required
      await moveTo("photographer1", job.id, "cancelled", { reason: "Shoot cancelled by client" });
      const after = await jobRow(job.id);
      expect(after.statusCategory).toBe("cancelled");
      expect(after.cancelledAt).toBe(fakeClock.now());
      expect(await eventsOf(job.id, "job.cancelled")).toHaveLength(1);
      await expectClean();
    });
  }
});

describe("missing edges", () => {
  it("every status pair without an edge is a 422 for a manager without override", async () => {
    const edgeKeys = new Set(Object.keys(ids.transitions));
    const failures: string[] = [];
    for (const from of DEFAULT_WORKFLOW_STATUSES) {
      for (const to of DEFAULT_WORKFLOW_STATUSES) {
        if (from.key === to.key || edgeKeys.has(`${from.key}->${to.key}`)) continue;
        if (from.key === "cancelled" && to.key === "new") continue; // computed restore target
        const { job } = await insertJobFixture(db, ids, { statusKey: from.key });
        const err = await catchErr(moveTo("coAdmin", job.id, to.key, { reason: "x", revision: revisionPayload }));
        if (err.status !== 422 || err.code !== "invalid_transition") failures.push(`${from.key}->${to.key}: ${err.code}`);
        expect((await jobRow(job.id)).statusId).toBe(ids.statuses[from.key]);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("override", () => {
  it("lets a manager jump any → any with a reason, flagged is_override", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "new" });
    expect((await catchErr(moveTo("coAdmin", job.id, "in_progress", { override: true }))).status).toBe(400);
    expect((await catchErr(moveTo("coAdmin", job.id, "in_progress", { override: true, reason: "Imported" }))).code).toBe("editor_required");
    await act("coAdmin", assignEditor, job.id, { userId: ids.users.editor1 });
    const res = await moveTo("coAdmin", job.id, "approved", { override: true, reason: "Imported from the old system" });
    expect(res.isOverride).toBe(true);
    const row = (await transitionsOf(job.id)).at(-1);
    expect(row).toMatchObject({ isOverride: true, reason: "Imported from the old system" });
    expect((await eventsOf(job.id, "job.status_changed")).at(-1)?.metadata.isOverride).toBe(true);
    expect((await jobRow(job.id)).approvedAt).toBe(fakeClock.now());
    await expectClean();
  });

  it("is forbidden for photographers", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "new" });
    expect((await catchErr(moveTo("photographer1", job.id, "completed", { override: true, reason: "x" }))).status).toBe(403);
  });
});

describe("actor checks", () => {
  it("assigneeOnly: a past editor may view but not act; a manager acts on behalf", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "assigned", editorId: ids.users.editor2 });
    await act("coAdmin", assignEditor, job.id, { userId: ids.users.editor1 });
    const err = await catchErr(moveTo("editor2", job.id, "accepted"));
    expect(err.status).toBe(403);
    const res = await moveTo("coAdmin", job.id, "accepted");
    expect(res.toStatus.category).toBe("accepted");
    expect((await eventsOf(job.id, "job.status_changed")).at(-1)?.metadata.onBehalfOf).toBe(ids.users.editor1);
  });

  it("an unrelated editor gets 404 (existence never leaks); another org's job is 404", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "assigned" });
    expect((await catchErr(moveTo("editor2", job.id, "accepted"))).status).toBe(404);
    const other = await seedMinimalOrg(db, { slug: "other" });
    const foreign = (await insertJobFixture(db, other, { statusKey: "new" })).job;
    expect((await catchErr(move("coAdmin", foreign.id, { toStatusId: other.statuses.ready }))).status).toBe(404);
    // status of another workflow / org → 404
    expect((await catchErr(move("coAdmin", job.id, { toStatusId: other.statuses.accepted }))).status).toBe(404);
  });

  it("photographers act only on their own jobs", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "submitted", photographerId: ids.users.photographer2, createdByUserId: ids.users.photographer2 });
    expect((await catchErr(moveTo("photographer1", job.id, "approved"))).status).toBe(404);
    expect((await moveTo("photographer2", job.id, "approved")).toStatus.category).toBe("approved");
  });
});

describe("ledger invariants", () => {
  it("full happy path keeps one open row, contiguous sequence and zero drift", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "new", dueDate: "2026-10-12T12:59:59.999Z" });
    const step = async (fn: () => Promise<unknown>) => {
      fakeClock.advanceHours(1);
      await fn();
    };
    await step(() => moveTo("photographer1", job.id, "ready"));
    await step(() => act("photographer1", assignEditor, job.id, { userId: ids.users.editor1 }));
    await step(() => act("editor1", acceptJob, job.id));
    await step(() => act("editor1", startJob, job.id));
    await step(() => act("editor1", submitJob, job.id));
    await step(() => act("photographer1", beginReview, job.id));
    await step(() => moveTo("photographer1", job.id, "revision", { revision: revisionPayload }));
    await step(() => moveTo("editor1", job.id, "resubmitted"));
    await step(() => act("photographer1", approveJob, job.id));
    await step(() => act("photographer1", deliverJob, job.id));
    await step(() => act("photographer1", completeJob, job.id));

    const rows = await transitionsOf(job.id);
    expect(rows.map((r) => r.sequence)).toEqual(rows.map((_, i) => i + 1));
    expect(rows.filter((r) => r.exitedAt === null)).toHaveLength(1);
    for (const r of rows.slice(0, -1)) {
      expect(r.exitedAt).not.toBeNull();
      expect(r.durationSeconds).toBe(3600);
    }
    const after = await jobRow(job.id);
    expect(after).toMatchObject({ statusCategory: "completed", revisionCount: 1, openRevisionId: null, completionPercent: 100, wasOnTime: true });
    expect(after.startedAt).not.toBeNull();
    expect(after.firstSubmittedAt).not.toBe(after.lastSubmittedAt);
    for (const type of ["job.accepted", "job.work_started", "job.review_started", "job.approved", "job.delivered", "job.completed", "revision.requested", "revision.resolved"]) {
      expect(await eventsOf(job.id, type), type).toHaveLength(1);
    }
    expect(await eventsOf(job.id, "job.submitted")).toHaveLength(2);
    await expectClean();
  });

  it("409 on a stale expectedVersion, with the current row", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "new" });
    const err = await catchErr(as("coAdmin", (tx, ctx) => transitionJobStatus(tx, ctx, { jobId: job.id, toStatusId: ids.statuses.ready, expectedVersion: job.version + 5 })));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect((err as ConflictError<Job>).current?.id).toBe(job.id);
    expect(await transitionsOf(job.id)).toHaveLength(1);
  });
});

describe("side effects per category (§4.4)", () => {
  it("in_progress stamps started_at once and floors completion at 5", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "accepted" });
    await moveTo("editor1", job.id, "in_progress");
    const after = await jobRow(job.id);
    expect(after.startedAt).toBe(T0);
    expect(after.completionPercent).toBe(5);
    expect(await eventsOf(job.id, "job.work_started")).toHaveLength(1);
  });

  it("submitted: milestones, completion ≥ 90, review SLA default (audited), work_submitted notice + link warning", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress", createdByUserId: ids.users.coAdmin });
    const res = await moveTo("editor1", job.id, "submitted");
    const after = await jobRow(job.id);
    expect(after.firstSubmittedAt).toBe(T0);
    expect(after.lastSubmittedAt).toBe(T0);
    expect(after.completionPercent).toBe(90);
    expect(after.reviewDueDate).toBe("2026-10-09T00:00:00.000Z");
    const sla = await eventsOf(job.id, "job.review_due_date_changed");
    expect(sla).toHaveLength(1);
    expect(sla[0].metadata.cause).toBe("sla_default");
    expect(sla[0].summary).toContain("review SLA");
    expect(res.warnings).toHaveLength(1);
    const recipients = (await db.select().from(notifications).where(eq(notifications.type, "work_submitted"))).map((n) => n.userId);
    expect(recipients.sort()).toEqual([ids.users.coAdmin, ids.users.photographer1].sort());
  });

  it("an existing review deadline is never overwritten by the SLA", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress", reviewDueDate: "2026-10-30T12:59:59.999Z" });
    await moveTo("editor1", job.id, "submitted");
    expect((await jobRow(job.id)).reviewDueDate).toBe("2026-10-30T12:59:59.999Z");
    expect(await eventsOf(job.id, "job.review_due_date_changed")).toHaveLength(0);
  });

  it("approve snapshots due_date_at_approval / was_on_time (late approval → false)", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "submitted", dueDate: "2026-10-07T12:59:59.999Z" });
    await moveTo("photographer1", job.id, "approved");
    const after = await jobRow(job.id);
    expect(after).toMatchObject({ approvedAt: T0, approvedByUserId: ids.users.photographer1, dueDateAtApproval: "2026-10-07T12:59:59.999Z", wasOnTime: false, completionPercent: 100 });
    expect((await eventsOf(job.id, "job.approved"))[0].metadata).toMatchObject({ onTime: false, dueDateAtApproval: "2026-10-07T12:59:59.999Z", revisionCount: 0 });
    expect((await db.select().from(notifications).where(eq(notifications.type, "work_approved"))).map((n) => n.userId)).toEqual([ids.users.editor1]);
  });

  it("cancel closes running sessions and the open revision; assignments stay open", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "submitted" });
    await moveTo("photographer1", job.id, "revision", { revision: revisionPayload });
    await as("editor1", (tx, ctx) => startTimer(tx, ctx, { jobId: job.id }));
    expect(await db.select().from(workSessions).where(isNull(workSessions.endedAt))).toHaveLength(1);
    await act("coAdmin", cancelJob, job.id, { reason: "Client went elsewhere" });
    const sessions = await db.select().from(workSessions);
    expect(sessions[0]).toMatchObject({ endReason: "auto_status_change" });
    const rev = await first(db.select().from(jobRevisions).where(eq(jobRevisions.jobId, job.id)));
    expect(rev).toMatchObject({ resolution: "cancelled" });
    expect(await jobRow(job.id)).toMatchObject({ openRevisionId: null, editorId: ids.users.editor1, statusCategory: "cancelled" });
    expect(await db.select().from(jobAssignments).where(and(eq(jobAssignments.jobId, job.id), isNull(jobAssignments.unassignedAt)))).toHaveLength(2);
    await expectClean();
  });

  it("reopen clears completed_at, bumps reopened_count and keeps history", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "completed" });
    expect((await catchErr(as("photographer1", (tx, ctx) => reopenJob(tx, ctx, { jobId: job.id, expectedVersion: job.version })))).status).toBe(400);
    fakeClock.advanceDays(2);
    await as("photographer1", (tx, ctx) => reopenJob(tx, ctx, { jobId: job.id, expectedVersion: job.version, reason: "Missed two rooms" }));
    let after = await jobRow(job.id);
    expect(after).toMatchObject({ statusCategory: "in_progress", completedAt: null, approvedAt: null, reopenedCount: 1 });
    const rows = await transitionsOf(job.id);
    expect(rows[0]).toMatchObject({ toStatusId: ids.statuses.completed, exitedAt: fakeClock.now() });
    expect(rows[1]).toMatchObject({ isReopen: true, reason: "Missed two rooms" });
    expect((await eventsOf(job.id, "job.reopened"))[0].previousValue).toEqual({ completedAt: T0 });
    // finish again: the new completion is the only one on the job row
    fakeClock.advanceHours(1);
    await moveTo("editor1", job.id, "submitted");
    await moveTo("photographer1", job.id, "approved");
    await moveTo("photographer1", job.id, "completed");
    after = await jobRow(job.id);
    expect(after.completedAt).toBe(fakeClock.now());
    expect((await transitionsOf(job.id)).filter((r) => r.toStatusId === ids.statuses.completed)).toHaveLength(2);
    await expectClean();
  });

  it("pause is cleared by any transition", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress", isPaused: true });
    await moveTo("editor1", job.id, "submitted");
    expect(await jobRow(job.id)).toMatchObject({ isPaused: false, pausedAt: null });
  });
});

describe("decline", () => {
  it("assigned → ready by the editor: editor removed, previous_editor kept, job_declined to photographer + admins", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "assigned" });
    const res = await as("editor1", (tx, ctx) => declineJob(tx, ctx, { jobId: job.id, expectedVersion: job.version, reason: "On leave" }));
    expect(res.toStatus.category).toBe("ready");
    const after = await jobRow(job.id);
    expect(after).toMatchObject({ editorId: null, previousEditorId: ids.users.editor1 });
    expect((await transitionsOf(job.id)).at(-1)?.editorIdAtEntry).toBeNull();
    const closed = await first(db.select().from(jobAssignments).where(and(eq(jobAssignments.jobId, job.id), eq(jobAssignments.role, "editor"))));
    expect(closed).toMatchObject({ unassignReason: "declined", unassignedByUserId: ids.users.editor1 });
    expect((await eventsOf(job.id, "job.declined"))[0].metadata.reason).toBe("On leave");
    const recipients = (await db.select().from(notifications).where(eq(notifications.type, "job_declined"))).map((n) => n.userId);
    expect(recipients.sort()).toEqual([ids.users.coAdmin, ids.users.owner, ids.users.photographer1].sort());
    await expectClean();
  });

  it("an admin's move to ready is an unassignment, never a decline (roles v2 §5.2)", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "assigned" });
    const res = await as("coAdmin", (tx, ctx) => declineJob(tx, ctx, { jobId: job.id, expectedVersion: job.version }));
    expect(res.toStatus.category).toBe("ready");
    const closed = await first(db.select().from(jobAssignments).where(and(eq(jobAssignments.jobId, job.id), eq(jobAssignments.role, "editor"))));
    expect(closed).toMatchObject({ unassignReason: "unassigned", unassignedByUserId: ids.users.coAdmin });
    expect(await eventsOf(job.id, "job.declined")).toHaveLength(0);
    expect((await db.select().from(notifications).where(eq(notifications.type, "job_unassigned"))).map((n) => n.userId)).toEqual([ids.users.editor1]);
    await expectClean();
  });
});

describe("restore", () => {
  it("returns a cancelled job to the status it was cancelled from", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    await moveTo("coAdmin", job.id, "cancelled", { reason: "Paused by client" });
    fakeClock.advanceDays(1);
    const res = await act("photographer1", restoreJob, job.id);
    expect(res.isRestore).toBe(true);
    expect(await jobRow(job.id)).toMatchObject({ statusId: ids.statuses.in_progress, cancelledAt: null, editorId: ids.users.editor1 });
    expect(await eventsOf(job.id, "job.restored")).toHaveLength(1);
    await expectClean();
  });

  it("falls back to Ready when the editor was deactivated meanwhile", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    await moveTo("coAdmin", job.id, "cancelled", { reason: "On hold" });
    await db.update(users).set({ isActive: false }).where(eq(users.id, ids.users.editor1));
    await act("coAdmin", restoreJob, job.id);
    expect(await jobRow(job.id)).toMatchObject({ statusId: ids.statuses.ready, editorId: null, previousEditorId: ids.users.editor1 });
    await expectClean();
  });

  it("transitionJobStatus to the restore target works; any other target is 422", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "review" });
    await moveTo("coAdmin", job.id, "cancelled", { reason: "x" });
    expect((await catchErr(moveTo("coAdmin", job.id, "approved"))).code).toBe("invalid_transition");
    expect((await moveTo("coAdmin", job.id, "review")).isRestore).toBe(true);
  });
});

describe("custom workflow shapes", () => {
  async function addFinalCut(withEdgeFromAccepted: boolean, sortOrder = 4) {
    const id = "studio-st-final_cut";
    await db
      .insert(workflowStatuses)
      .values({ id, organisationId: ids.organisationId, workflowId: ids.workflowId, key: "final_cut", name: "Final Cut", category: "in_progress", sortOrder, isInitial: false });
    await db
      .insert(workflowTransitions)
      .values({ organisationId: ids.organisationId, workflowId: ids.workflowId, fromStatusId: id, toStatusId: ids.statuses.submitted, allowedRoles: ["admin", "editor"], assigneeOnly: true });
    if (withEdgeFromAccepted) {
      await db
        .insert(workflowTransitions)
        .values({ organisationId: ids.organisationId, workflowId: ids.workflowId, fromStatusId: ids.statuses.accepted, toStatusId: id, allowedRoles: ["admin", "editor"], assigneeOnly: true });
    }
    return id;
  }

  it("lateral moves between statuses of one category need no edge", async () => {
    const finalCut = await addFinalCut(false);
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    const res = await move("editor1", job.id, { toStatusId: finalCut });
    expect(res.isLateral).toBe(true);
    expect((await eventsOf(job.id, "job.status_changed"))[0].metadata.lateral).toBe(true);
    await expectClean();
  });

  it("a category with several reachable statuses is ambiguous (422)", async () => {
    await addFinalCut(true);
    const { job } = await insertJobFixture(db, ids, { statusKey: "accepted" });
    const err = await catchErr(move("editor1", job.id, { toCategory: "in_progress" }));
    expect(err.code).toBe("ambiguous_target");
    expect((err.details as { candidates: unknown[] }).candidates).toHaveLength(2);
  });

  it("migrateWorkflow writes a migration row and a job.workflow_migrated event", async () => {
    const other = await insertDefaultWorkflow(db, ids.organisationId, { idPrefix: "alt", name: "Alt workflow", isDefault: false });
    const { job } = await insertJobFixture(db, ids, { statusKey: "in_progress" });
    const input = { jobId: job.id, workflowId: other.workflowId, toStatusId: other.statuses.in_progress, expectedVersion: job.version };
    expect((await catchErr(as("photographer1", (tx, ctx) => migrateWorkflow(tx, ctx, input)))).status).toBe(403);
    const res = await as("coAdmin", (tx, ctx) => migrateWorkflow(tx, ctx, input));
    expect(res.job).toMatchObject({ workflowId: other.workflowId, statusId: other.statuses.in_progress });
    expect((await transitionsOf(job.id)).at(-1)).toMatchObject({ kind: "migration", activityEventId: res.eventId });
    expect(await eventsOf(job.id, "job.workflow_migrated")).toHaveLength(1);
    await expectClean();
  });
});

describe("system context & allowed transitions", () => {
  it("an automation (system context) can move approved → completed by category", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "approved" });
    const sys = await systemContextFor(db, ids.organisationId, { cause: "sweep" });
    const res = await run((tx) => transitionLoadedJob(tx, sys, job.id, { toCategory: "completed" }));
    expect(res.toStatus.category).toBe("completed");
    expect((await transitionsOf(job.id)).at(-1)?.actorUserId).toBeNull();
    await expectClean();
  });

  it("getAllowedTransitions lists the editor's buttons and kanban columns", async () => {
    const { job } = await insertJobFixture(db, ids, { statusKey: "assigned" });
    const res = await getAllowedTransitions(db, await ctxOf("editor1"), job.id);
    expect(res.transitions.map((t) => t.label).sort()).toEqual(["Accept", "Decline", "Start"]);
    expect(res.allowedColumns.sort()).toEqual(["in_progress", "new"]);
    const admin = (await getAllowedTransitions(db, await ctxOf("coAdmin"), job.id)).transitions;
    expect(admin.map((t) => t.toStatus.key)).toEqual(["ready", "accepted", "in_progress", "cancelled"]);
    expect(admin.find((t) => t.toStatus.key === "ready")?.label).toBe("Unassign editor");
  });
});
