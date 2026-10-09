import { and, asc, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tx } from "@/db/index";
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
import type { Job } from "@/lib/types";
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

beforeEach(() => {
  fakeClock.set(T0);
  db = makeTestDb();
  ids = seedMinimalOrg(db, { settings: { timeTrackingEnabled: true } });
});
afterEach(() => fakeClock.reset());

const ctxOf = (key: FixtureUserKey) => contextFor(db, ids.users[key]);
const run = <T>(fn: (tx: Tx) => T): T => withTx(fn, { db });
const jobRow = (id: string): Job => {
  const row = db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (!row) throw new Error("job missing");
  return row;
};
const transitionsOf = (jobId: string) =>
  db.select().from(jobStatusTransitions).where(eq(jobStatusTransitions.jobId, jobId)).orderBy(asc(jobStatusTransitions.sequence)).all();
const eventsOf = (jobId: string, type?: string) =>
  db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.jobId, jobId), type ? eq(activityEvents.eventType, type) : undefined))
    .all();
const revisionPayload = { reason: "Colour", description: "Warm up the kitchen shots", instructions: "Use the client's reference" };

function move(actor: FixtureUserKey, jobId: string, input: Record<string, unknown>) {
  const job = jobRow(jobId);
  return run((tx) => transitionJobStatus(tx, ctxOf(actor), { jobId, expectedVersion: job.version, ...input }));
}
function moveTo(actor: FixtureUserKey, jobId: string, statusKey: string, extra: Record<string, unknown> = {}) {
  return move(actor, jobId, { toStatusId: ids.statuses[statusKey], ...extra });
}
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

const ENGINE_INTERNAL = (from: string, to: string) =>
  to === "assigned" || (to === "ready" && ["accepted", "in_progress", "revision"].includes(from));

describe("default edges (§4.2)", () => {
  for (const def of DEFAULT_WORKFLOW_TRANSITIONS) {
    const internal = ENGINE_INTERNAL(def.from, def.to);
    it(`${def.from} → ${def.to} ${internal ? "is engine-internal (422 via transitionJobStatus)" : "succeeds with its ledger rows"}`, () => {
      const { job } = insertJobFixture(db, ids, { statusKey: def.from, dueDate: "2026-10-20T12:59:59.999Z" });
      if (internal) {
        const err = catchErr(() => moveTo("manager", job.id, def.to));
        expect(err.status).toBe(422);
        // requiresAssignedEditor edges explain the missing editor first
        expect(["invalid_transition", "editor_required"]).toContain(err.code);
        return;
      }
      const actor: FixtureUserKey = def.assigneeOnly ? "editor1" : "photographer1";
      fakeClock.advanceMinutes(30);
      const result = moveTo(actor, job.id, def.to, {
        ...(def.isReopen ? { reason: "Client asked for changes" } : {}),
        ...(def.to === "revision" ? { revision: revisionPayload } : {}),
      });
      const after = jobRow(job.id);
      expect(after.statusId).toBe(ids.statuses[def.to]);
      expect(after.statusCategory).toBe(def.to);
      expect(after.previousStatusId).toBe(ids.statuses[def.from]);
      expect(after.version).toBeGreaterThan(job.version);
      const rows = transitionsOf(job.id);
      expect(rows.filter((r) => r.exitedAt === null)).toHaveLength(1);
      const last = rows[rows.length - 1];
      expect(last).toMatchObject({ id: result.transitionId, kind: "transition", toStatusId: ids.statuses[def.to], isReopen: def.isReopen ?? false });
      expect(rows[0].durationSeconds).toBe(1800);
      expect(last.activityEventId).toBe(result.eventId);
      const evt = eventsOf(job.id, "job.status_changed")[0];
      expect(evt.metadata.transitionId).toBe(result.transitionId);
      expectClean();
    });
  }

  for (const s of DEFAULT_WORKFLOW_STATUSES.filter((x) => STATUS_CATEGORY_META[x.category].open)) {
    it(`${s.key} → cancelled (generated edge) closes the stage and stamps cancelled_at`, () => {
      const { job } = insertJobFixture(db, ids, { statusKey: s.key });
      const err = catchErr(() => moveTo("photographer1", job.id, "cancelled"));
      expect(err.status).toBe(400); // reason required
      moveTo("photographer1", job.id, "cancelled", { reason: "Shoot cancelled by client" });
      const after = jobRow(job.id);
      expect(after.statusCategory).toBe("cancelled");
      expect(after.cancelledAt).toBe(fakeClock.now());
      expect(eventsOf(job.id, "job.cancelled")).toHaveLength(1);
      expectClean();
    });
  }
});

describe("missing edges", () => {
  it("every status pair without an edge is a 422 for a manager without override", () => {
    const edgeKeys = new Set(Object.keys(ids.transitions));
    const failures: string[] = [];
    for (const from of DEFAULT_WORKFLOW_STATUSES) {
      for (const to of DEFAULT_WORKFLOW_STATUSES) {
        if (from.key === to.key || edgeKeys.has(`${from.key}->${to.key}`)) continue;
        if (from.key === "cancelled" && to.key === "new") continue; // computed restore target
        const { job } = insertJobFixture(db, ids, { statusKey: from.key });
        const err = catchErr(() => moveTo("manager", job.id, to.key, { reason: "x", revision: revisionPayload }));
        if (err.status !== 422 || err.code !== "invalid_transition") failures.push(`${from.key}->${to.key}: ${err.code}`);
        expect(jobRow(job.id).statusId).toBe(ids.statuses[from.key]);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("override", () => {
  it("lets a manager jump any → any with a reason, flagged is_override", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "new" });
    expect(catchErr(() => moveTo("manager", job.id, "in_progress", { override: true })).status).toBe(400);
    expect(catchErr(() => moveTo("manager", job.id, "in_progress", { override: true, reason: "Imported" })).code).toBe("editor_required");
    run((tx) => assignEditor(tx, ctxOf("manager"), { jobId: job.id, userId: ids.users.editor1, expectedVersion: jobRow(job.id).version }));
    const res = moveTo("manager", job.id, "approved", { override: true, reason: "Imported from the old system" });
    expect(res.isOverride).toBe(true);
    const row = transitionsOf(job.id).at(-1);
    expect(row).toMatchObject({ isOverride: true, reason: "Imported from the old system" });
    expect(eventsOf(job.id, "job.status_changed").at(-1)?.metadata.isOverride).toBe(true);
    expect(jobRow(job.id).approvedAt).toBe(fakeClock.now());
    expectClean();
  });

  it("is forbidden for photographers", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "new" });
    expect(catchErr(() => moveTo("photographer1", job.id, "completed", { override: true, reason: "x" })).status).toBe(403);
  });
});

describe("actor checks", () => {
  it("assigneeOnly: a past editor may view but not act; a manager acts on behalf", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "assigned", editorId: ids.users.editor2 });
    run((tx) => assignEditor(tx, ctxOf("manager"), { jobId: job.id, userId: ids.users.editor1, expectedVersion: jobRow(job.id).version }));
    const err = catchErr(() => moveTo("editor2", job.id, "accepted"));
    expect(err.status).toBe(403);
    const res = moveTo("manager", job.id, "accepted");
    expect(res.toStatus.category).toBe("accepted");
    expect(eventsOf(job.id, "job.status_changed").at(-1)?.metadata.onBehalfOf).toBe(ids.users.editor1);
  });

  it("an unrelated editor gets 404 (existence never leaks); another org's job is 404", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "assigned" });
    expect(catchErr(() => moveTo("editor2", job.id, "accepted")).status).toBe(404);
    const other = seedMinimalOrg(db, { slug: "other" });
    const foreign = insertJobFixture(db, other, { statusKey: "new" }).job;
    expect(catchErr(() => move("manager", foreign.id, { toStatusId: other.statuses.ready })).status).toBe(404);
    // status of another workflow / org → 404
    expect(catchErr(() => move("manager", job.id, { toStatusId: other.statuses.accepted })).status).toBe(404);
  });

  it("photographers act only on their own jobs", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "submitted", photographerId: ids.users.photographer2, createdByUserId: ids.users.photographer2 });
    expect(catchErr(() => moveTo("photographer1", job.id, "approved")).status).toBe(404);
    expect(moveTo("photographer2", job.id, "approved").toStatus.category).toBe("approved");
  });
});

describe("ledger invariants", () => {
  it("full happy path keeps one open row, contiguous sequence and zero drift", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "new", dueDate: "2026-10-12T12:59:59.999Z" });
    const step = (fn: () => unknown) => {
      fakeClock.advanceHours(1);
      fn();
    };
    step(() => moveTo("photographer1", job.id, "ready"));
    step(() => run((tx) => assignEditor(tx, ctxOf("photographer1"), { jobId: job.id, userId: ids.users.editor1, expectedVersion: jobRow(job.id).version })));
    step(() => run((tx) => acceptJob(tx, ctxOf("editor1"), { jobId: job.id, expectedVersion: jobRow(job.id).version })));
    step(() => run((tx) => startJob(tx, ctxOf("editor1"), { jobId: job.id, expectedVersion: jobRow(job.id).version })));
    step(() => run((tx) => submitJob(tx, ctxOf("editor1"), { jobId: job.id, expectedVersion: jobRow(job.id).version })));
    step(() => run((tx) => beginReview(tx, ctxOf("photographer1"), { jobId: job.id, expectedVersion: jobRow(job.id).version })));
    step(() => moveTo("photographer1", job.id, "revision", { revision: revisionPayload }));
    step(() => moveTo("editor1", job.id, "resubmitted"));
    step(() => run((tx) => approveJob(tx, ctxOf("photographer1"), { jobId: job.id, expectedVersion: jobRow(job.id).version })));
    step(() => run((tx) => deliverJob(tx, ctxOf("photographer1"), { jobId: job.id, expectedVersion: jobRow(job.id).version })));
    step(() => run((tx) => completeJob(tx, ctxOf("photographer1"), { jobId: job.id, expectedVersion: jobRow(job.id).version })));

    const rows = transitionsOf(job.id);
    expect(rows.map((r) => r.sequence)).toEqual(rows.map((_, i) => i + 1));
    expect(rows.filter((r) => r.exitedAt === null)).toHaveLength(1);
    for (const r of rows.slice(0, -1)) {
      expect(r.exitedAt).not.toBeNull();
      expect(r.durationSeconds).toBe(3600);
    }
    const after = jobRow(job.id);
    expect(after).toMatchObject({ statusCategory: "completed", revisionCount: 1, openRevisionId: null, completionPercent: 100, wasOnTime: true });
    expect(after.startedAt).not.toBeNull();
    expect(after.firstSubmittedAt).not.toBe(after.lastSubmittedAt);
    for (const type of ["job.accepted", "job.work_started", "job.review_started", "job.approved", "job.delivered", "job.completed", "revision.requested", "revision.resolved"]) {
      expect(eventsOf(job.id, type), type).toHaveLength(1);
    }
    expect(eventsOf(job.id, "job.submitted")).toHaveLength(2);
    expectClean();
  });

  it("409 on a stale expectedVersion, with the current row", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "new" });
    const err = catchErr(() => run((tx) => transitionJobStatus(tx, ctxOf("manager"), { jobId: job.id, toStatusId: ids.statuses.ready, expectedVersion: job.version + 5 })));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect((err as ConflictError<Job>).current?.id).toBe(job.id);
    expect(transitionsOf(job.id)).toHaveLength(1);
  });
});

describe("side effects per category (§4.4)", () => {
  it("in_progress stamps started_at once and floors completion at 5", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "accepted" });
    moveTo("editor1", job.id, "in_progress");
    const first = jobRow(job.id);
    expect(first.startedAt).toBe(T0);
    expect(first.completionPercent).toBe(5);
    expect(eventsOf(job.id, "job.work_started")).toHaveLength(1);
  });

  it("submitted: milestones, completion ≥ 90, review SLA default (audited), work_submitted notice + link warning", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress", createdByUserId: ids.users.manager });
    const res = moveTo("editor1", job.id, "submitted");
    const after = jobRow(job.id);
    expect(after.firstSubmittedAt).toBe(T0);
    expect(after.lastSubmittedAt).toBe(T0);
    expect(after.completionPercent).toBe(90);
    expect(after.reviewDueDate).toBe("2026-10-09T00:00:00.000Z");
    const sla = eventsOf(job.id, "job.review_due_date_changed");
    expect(sla).toHaveLength(1);
    expect(sla[0].metadata.cause).toBe("sla_default");
    expect(sla[0].summary).toContain("review SLA");
    expect(res.warnings).toHaveLength(1);
    const recipients = db.select().from(notifications).where(eq(notifications.type, "work_submitted")).all().map((n) => n.userId);
    expect(recipients.sort()).toEqual([ids.users.manager, ids.users.photographer1].sort());
  });

  it("an existing review deadline is never overwritten by the SLA", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress", reviewDueDate: "2026-10-30T12:59:59.999Z" });
    moveTo("editor1", job.id, "submitted");
    expect(jobRow(job.id).reviewDueDate).toBe("2026-10-30T12:59:59.999Z");
    expect(eventsOf(job.id, "job.review_due_date_changed")).toHaveLength(0);
  });

  it("approve snapshots due_date_at_approval / was_on_time (late approval → false)", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "submitted", dueDate: "2026-10-07T12:59:59.999Z" });
    moveTo("photographer1", job.id, "approved");
    const after = jobRow(job.id);
    expect(after).toMatchObject({ approvedAt: T0, approvedByUserId: ids.users.photographer1, dueDateAtApproval: "2026-10-07T12:59:59.999Z", wasOnTime: false, completionPercent: 100 });
    expect(eventsOf(job.id, "job.approved")[0].metadata).toMatchObject({ onTime: false, dueDateAtApproval: "2026-10-07T12:59:59.999Z", revisionCount: 0 });
    expect(db.select().from(notifications).where(eq(notifications.type, "work_approved")).all().map((n) => n.userId)).toEqual([ids.users.editor1]);
  });

  it("cancel closes running sessions and the open revision; assignments stay open", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "submitted" });
    moveTo("photographer1", job.id, "revision", { revision: revisionPayload });
    run((tx) => startTimer(tx, ctxOf("editor1"), { jobId: job.id }));
    expect(db.select().from(workSessions).where(isNull(workSessions.endedAt)).all()).toHaveLength(1);
    run((tx) => cancelJob(tx, ctxOf("manager"), { jobId: job.id, expectedVersion: jobRow(job.id).version, reason: "Client went elsewhere" }));
    const sessions = db.select().from(workSessions).all();
    expect(sessions[0]).toMatchObject({ endReason: "auto_status_change" });
    const rev = db.select().from(jobRevisions).where(eq(jobRevisions.jobId, job.id)).get();
    expect(rev).toMatchObject({ resolution: "cancelled" });
    expect(jobRow(job.id)).toMatchObject({ openRevisionId: null, editorId: ids.users.editor1, statusCategory: "cancelled" });
    expect(db.select().from(jobAssignments).where(and(eq(jobAssignments.jobId, job.id), isNull(jobAssignments.unassignedAt))).all()).toHaveLength(2);
    expectClean();
  });

  it("reopen clears completed_at, bumps reopened_count and keeps history", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "completed" });
    expect(catchErr(() => run((tx) => reopenJob(tx, ctxOf("photographer1"), { jobId: job.id, expectedVersion: job.version }))).status).toBe(400);
    fakeClock.advanceDays(2);
    run((tx) => reopenJob(tx, ctxOf("photographer1"), { jobId: job.id, expectedVersion: job.version, reason: "Missed two rooms" }));
    let after = jobRow(job.id);
    expect(after).toMatchObject({ statusCategory: "in_progress", completedAt: null, approvedAt: null, reopenedCount: 1 });
    const rows = transitionsOf(job.id);
    expect(rows[0]).toMatchObject({ toStatusId: ids.statuses.completed, exitedAt: fakeClock.now() });
    expect(rows[1]).toMatchObject({ isReopen: true, reason: "Missed two rooms" });
    expect(eventsOf(job.id, "job.reopened")[0].previousValue).toEqual({ completedAt: T0 });
    // finish again: the new completion is the only one on the job row
    fakeClock.advanceHours(1);
    moveTo("editor1", job.id, "submitted");
    moveTo("photographer1", job.id, "approved");
    moveTo("photographer1", job.id, "completed");
    after = jobRow(job.id);
    expect(after.completedAt).toBe(fakeClock.now());
    expect(transitionsOf(job.id).filter((r) => r.toStatusId === ids.statuses.completed)).toHaveLength(2);
    expectClean();
  });

  it("pause is cleared by any transition", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress", isPaused: true });
    moveTo("editor1", job.id, "submitted");
    expect(jobRow(job.id)).toMatchObject({ isPaused: false, pausedAt: null });
  });
});

describe("decline", () => {
  it("assigned → ready by the editor: editor removed, previous_editor kept, job_declined to photographer + managers", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "assigned" });
    const res = run((tx) => declineJob(tx, ctxOf("editor1"), { jobId: job.id, expectedVersion: job.version, reason: "On leave" }));
    expect(res.toStatus.category).toBe("ready");
    const after = jobRow(job.id);
    expect(after).toMatchObject({ editorId: null, previousEditorId: ids.users.editor1 });
    expect(transitionsOf(job.id).at(-1)?.editorIdAtEntry).toBeNull();
    const closed = db.select().from(jobAssignments).where(and(eq(jobAssignments.jobId, job.id), eq(jobAssignments.role, "editor"))).get();
    expect(closed).toMatchObject({ unassignReason: "declined", unassignedByUserId: ids.users.editor1 });
    expect(eventsOf(job.id, "job.declined")[0].metadata.reason).toBe("On leave");
    const recipients = db.select().from(notifications).where(eq(notifications.type, "job_declined")).all().map((n) => n.userId);
    expect(recipients.sort()).toEqual([ids.users.manager, ids.users.owner, ids.users.photographer1].sort());
    expectClean();
  });

  it("is not available to managers (unassign goes through the assignment service)", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "assigned" });
    expect(catchErr(() => run((tx) => declineJob(tx, ctxOf("manager"), { jobId: job.id, expectedVersion: job.version }))).code).toBe("invalid_transition");
  });
});

describe("restore", () => {
  it("returns a cancelled job to the status it was cancelled from", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress" });
    moveTo("manager", job.id, "cancelled", { reason: "Paused by client" });
    fakeClock.advanceDays(1);
    const res = run((tx) => restoreJob(tx, ctxOf("photographer1"), { jobId: job.id, expectedVersion: jobRow(job.id).version }));
    expect(res.isRestore).toBe(true);
    expect(jobRow(job.id)).toMatchObject({ statusId: ids.statuses.in_progress, cancelledAt: null, editorId: ids.users.editor1 });
    expect(eventsOf(job.id, "job.restored")).toHaveLength(1);
    expectClean();
  });

  it("falls back to Ready when the editor was deactivated meanwhile", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress" });
    moveTo("manager", job.id, "cancelled", { reason: "On hold" });
    db.update(users).set({ isActive: false }).where(eq(users.id, ids.users.editor1)).run();
    run((tx) => restoreJob(tx, ctxOf("manager"), { jobId: job.id, expectedVersion: jobRow(job.id).version }));
    expect(jobRow(job.id)).toMatchObject({ statusId: ids.statuses.ready, editorId: null, previousEditorId: ids.users.editor1 });
    expectClean();
  });

  it("transitionJobStatus to the restore target works; any other target is 422", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "review" });
    moveTo("manager", job.id, "cancelled", { reason: "x" });
    expect(catchErr(() => moveTo("manager", job.id, "approved")).code).toBe("invalid_transition");
    expect(moveTo("manager", job.id, "review").isRestore).toBe(true);
  });
});

describe("custom workflow shapes", () => {
  function addFinalCut(withEdgeFromAccepted: boolean, sortOrder = 4) {
    const id = "studio-st-final_cut";
    db.insert(workflowStatuses)
      .values({ id, organisationId: ids.organisationId, workflowId: ids.workflowId, key: "final_cut", name: "Final Cut", category: "in_progress", sortOrder, isInitial: false })
      .run();
    db.insert(workflowTransitions)
      .values({ organisationId: ids.organisationId, workflowId: ids.workflowId, fromStatusId: id, toStatusId: ids.statuses.submitted, allowedRoles: ["owner", "manager", "editor"], assigneeOnly: true })
      .run();
    if (withEdgeFromAccepted) {
      db.insert(workflowTransitions)
        .values({ organisationId: ids.organisationId, workflowId: ids.workflowId, fromStatusId: ids.statuses.accepted, toStatusId: id, allowedRoles: ["owner", "manager", "editor"], assigneeOnly: true })
        .run();
    }
    return id;
  }

  it("lateral moves between statuses of one category need no edge", () => {
    const finalCut = addFinalCut(false);
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress" });
    const res = move("editor1", job.id, { toStatusId: finalCut });
    expect(res.isLateral).toBe(true);
    expect(eventsOf(job.id, "job.status_changed")[0].metadata.lateral).toBe(true);
    expectClean();
  });

  it("a category with several reachable statuses is ambiguous (422)", () => {
    addFinalCut(true);
    const { job } = insertJobFixture(db, ids, { statusKey: "accepted" });
    const err = catchErr(() => move("editor1", job.id, { toCategory: "in_progress" }));
    expect(err.code).toBe("ambiguous_target");
    expect((err.details as { candidates: unknown[] }).candidates).toHaveLength(2);
  });

  it("migrateWorkflow writes a migration row and a job.workflow_migrated event", () => {
    const other = insertDefaultWorkflow(db, ids.organisationId, { idPrefix: "alt", name: "Alt workflow", isDefault: false });
    const { job } = insertJobFixture(db, ids, { statusKey: "in_progress" });
    expect(catchErr(() => run((tx) => migrateWorkflow(tx, ctxOf("photographer1"), { jobId: job.id, workflowId: other.workflowId, toStatusId: other.statuses.in_progress, expectedVersion: job.version }))).status).toBe(403);
    const res = run((tx) =>
      migrateWorkflow(tx, ctxOf("manager"), { jobId: job.id, workflowId: other.workflowId, toStatusId: other.statuses.in_progress, expectedVersion: job.version }),
    );
    expect(res.job).toMatchObject({ workflowId: other.workflowId, statusId: other.statuses.in_progress });
    expect(transitionsOf(job.id).at(-1)).toMatchObject({ kind: "migration", activityEventId: res.eventId });
    expect(eventsOf(job.id, "job.workflow_migrated")).toHaveLength(1);
    expectClean();
  });
});

describe("system context & allowed transitions", () => {
  it("an automation (system context) can move approved → completed by category", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "approved" });
    const sys = systemContextFor(db, ids.organisationId, { cause: "sweep" });
    const res = run((tx) => transitionLoadedJob(tx, sys, job.id, { toCategory: "completed" }));
    expect(res.toStatus.category).toBe("completed");
    expect(transitionsOf(job.id).at(-1)?.actorUserId).toBeNull();
    expectClean();
  });

  it("getAllowedTransitions lists the editor's buttons and kanban columns", () => {
    const { job } = insertJobFixture(db, ids, { statusKey: "assigned" });
    const res = getAllowedTransitions(db, ctxOf("editor1"), job.id);
    expect(res.transitions.map((t) => t.label).sort()).toEqual(["Accept", "Decline", "Start"]);
    expect(res.allowedColumns.sort()).toEqual(["in_progress", "new"]);
    expect(getAllowedTransitions(db, ctxOf("manager"), job.id).transitions.map((t) => t.toStatus.key)).toEqual(["accepted", "in_progress", "cancelled"]);
  });
});
