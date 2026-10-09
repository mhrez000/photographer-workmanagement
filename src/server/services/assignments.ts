/**
 * Assignment service (ARCHITECTURE.md §4.5) — the ONLY writer of
 * `jobs.editor_id` / `photographer_id` / `previous_editor_id` (through
 * `swapEditor` in ./workflow for editors).
 *
 * Editor status handling on (re)assignment:
 *   - new | ready                       → status becomes `assigned` (engine-internal move)
 *   - assigned                          → status unchanged, stage re-attributed to the new editor
 *   - accepted                          → back to `assigned` (the new editor must accept)
 *   - in_progress | revision | resubmitted | submitted | review
 *                                       → status unchanged; the open stage is re-attributed
 *                                         (`kind='reattribution'`, `job.stage_reattributed`)
 *   - approved | delivered | completed  → ledger swap only (nobody is editing)
 *   - cancelled                         → refused (restore first)
 * Unassign (`userId = null`): editor-held (assigned / accepted / in_progress /
 * revision) → `ready` (else the initial status); elsewhere ledger swap only.
 *
 * Every function is synchronous (better-sqlite3 transactions).
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Db, Tx } from "@/db/index";
import { jobAssignments } from "@/db/schema";
import { CATEGORY_GROUPS, type StatusCategory, type UnassignReason } from "@/lib/constants";
import { newId } from "@/lib/ids";
import type { AuthContext, BulkResult, Job } from "@/lib/types";
import { AssignEditorInput, AssignInput, AssignPhotographerInput, BulkReassignInput, UnassignEditorInput } from "@/lib/validation/jobs";
import { assertCan } from "@/server/auth/permissions";
import { recordEvent } from "@/server/audit";
import { ValidationError } from "@/server/errors";
import { assertVersion, loadUserInOrg, parseInput } from "./_shared";
import { notify } from "./notifications";
import {
  applyMove,
  emitAutomationEvent,
  jobEventMeta,
  jobLinkPath,
  loadVisibleJob,
  loadWorkflowGraph,
  reattributeStage,
  runPerJob,
  swapEditor,
  unassignedTargetOf,
  updateJobRow,
  type ReattributeResult,
  type TransitionResult,
} from "./workflow";

const REATTRIBUTE_CATEGORIES: readonly StatusCategory[] = ["assigned", "in_progress", "revision", "resubmitted", "submitted", "review"];

export interface AssignEditorOptions {
  reason?: string | null;
  /** Reason recorded on the closed assignment row. */
  unassignReason?: UnassignReason;
  batchId?: string | null;
}

export interface AssignEditorResult {
  job: Job;
  /** false when the requested editor already holds the job (no writes). */
  changed: boolean;
  previousEditorId: string | null;
  /** The new open editor assignment (null when unassigning / unchanged). */
  assignmentId: string | null;
  /** Status move caused by the assignment (→ assigned / → ready), if any. */
  transition: TransitionResult | null;
  /** Stage re-attribution (status unchanged), if any. */
  reattribution: ReattributeResult | null;
}

function unassignReasonFrom(reason: string | null | undefined, explicit: UnassignReason | undefined): UnassignReason | undefined {
  if (explicit) return explicit;
  return reason === "user_deactivated" ? "user_deactivated" : undefined;
}

/**
 * Core editor (re)assignment on a loaded job — NO permission check (callers
 * check `job.assign_editor`, or are the deactivation flow). Validates the
 * target (in-org, active, editor) and applies the §4.5 status handling.
 */
export function assignEditorToJob(tx: Tx, ctx: AuthContext, jobIn: Job, userId: string | null, opts: AssignEditorOptions = {}): AssignEditorResult {
  let job = jobIn;
  const unchanged: AssignEditorResult = {
    job,
    changed: false,
    previousEditorId: job.editorId,
    assignmentId: null,
    transition: null,
    reattribution: null,
  };
  if (job.statusCategory === "cancelled") throw new ValidationError("Restore the cancelled job before changing its editor");
  if (userId) {
    const target = loadUserInOrg(tx, ctx, userId);
    if (!target.isActive) throw new ValidationError(`${target.name} is deactivated and cannot be assigned`);
    if (target.role !== "editor") throw new ValidationError(`${target.name} is not an editor`);
  }
  if (userId === job.editorId) return unchanged;

  const category = job.statusCategory;
  const previousEditorId = job.editorId;
  const swap = swapEditor(tx, ctx, job, userId, {
    reason: opts.reason,
    unassignReason: opts.unassignReason,
    batchId: opts.batchId,
  });
  job = swap.job;

  let transition: TransitionResult | null = null;
  let reattribution: ReattributeResult | null = null;
  const graph = loadWorkflowGraph(tx, ctx.organisationId, job.workflowId);

  if (userId === null) {
    if (CATEGORY_GROUPS.EDITOR_HOLDS.includes(category)) {
      transition = applyMove(tx, ctx, job, unassignedTargetOf(graph), graph, { mode: "internal", reason: opts.reason ?? "Editor unassigned", batchId: opts.batchId });
      job = transition.job;
    }
  } else if (category === "new" || category === "ready" || category === "accepted") {
    const assigned = graph.statuses
      .filter((s) => s.archivedAt === null && s.category === "assigned")
      .sort((a, b) => a.sortOrder - b.sortOrder)[0];
    if (assigned) {
      transition = applyMove(tx, ctx, job, assigned, graph, { mode: "internal", reason: opts.reason ?? null, batchId: opts.batchId });
      job = transition.job;
    } else if (category === "accepted") {
      reattribution = reattributeStage(tx, ctx, job, { previousEditorId, batchId: opts.batchId });
      job = reattribution.job;
    }
  } else if (REATTRIBUTE_CATEGORIES.includes(category)) {
    reattribution = reattributeStage(tx, ctx, job, { previousEditorId, batchId: opts.batchId });
    job = reattribution.job;
  }

  return { job, changed: true, previousEditorId, assignmentId: swap.assignmentId, transition, reattribution };
}

/** `POST /api/jobs/:id/assign { role: "editor", userId | null }` — assign, reassign or (null) unassign the editor. */
export function assignEditor(tx: Tx, ctx: AuthContext, input: unknown): AssignEditorResult {
  const p = parseInput(AssignEditorInput, input);
  const { job, ref } = loadVisibleJob(tx, ctx, p.jobId);
  assertCan(ctx, "job.assign_editor", ref);
  if (p.expectedVersion !== undefined) assertVersion(job, p.expectedVersion);
  return assignEditorToJob(tx, ctx, job, p.userId, {
    reason: p.reason,
    unassignReason: unassignReasonFrom(p.reason, p.unassignReason),
  });
}

/** Removes the editor (editor-held jobs go back to Ready). */
export function unassignEditor(tx: Tx, ctx: AuthContext, input: unknown): AssignEditorResult {
  const p = parseInput(UnassignEditorInput, input);
  const { job, ref } = loadVisibleJob(tx, ctx, p.jobId);
  assertCan(ctx, "job.assign_editor", ref);
  if (p.expectedVersion !== undefined) assertVersion(job, p.expectedVersion);
  return assignEditorToJob(tx, ctx, job, null, {
    reason: p.reason,
    unassignReason: unassignReasonFrom(p.reason, p.unassignReason),
  });
}

export interface AssignPhotographerResult {
  job: Job;
  changed: boolean;
  previousPhotographerId: string | null;
  assignmentId: string | null;
}

/** Assigns / replaces / removes the job's photographer (owner, manager or photographer role targets). */
export function assignPhotographer(tx: Tx, ctx: AuthContext, input: unknown): AssignPhotographerResult {
  const p = parseInput(AssignPhotographerInput, input);
  const { job: loaded, ref } = loadVisibleJob(tx, ctx, p.jobId);
  assertCan(ctx, "job.assign_photographer", ref);
  if (p.expectedVersion !== undefined) assertVersion(loaded, p.expectedVersion);
  if (loaded.statusCategory === "cancelled") throw new ValidationError("Restore the cancelled job before changing its photographer");
  const previous = loaded.photographerId;
  if (p.userId) {
    const target = loadUserInOrg(tx, ctx, p.userId);
    if (!target.isActive) throw new ValidationError(`${target.name} is deactivated and cannot be assigned`);
    if (target.role === "editor") throw new ValidationError(`${target.name} is an editor; choose a photographer, manager or owner`);
  }
  if (p.userId === previous) return { job: loaded, changed: false, previousPhotographerId: previous, assignmentId: null };

  const now = ctx.now();
  const meta = (extra: Record<string, unknown>) => jobEventMeta(loaded, extra);
  const open = tx
    .select()
    .from(jobAssignments)
    .where(and(eq(jobAssignments.jobId, loaded.id), eq(jobAssignments.role, "photographer"), isNull(jobAssignments.unassignedAt)))
    .get();
  const unassignReason: UnassignReason = p.unassignReason ?? (p.userId ? "reassigned" : "unassigned");
  let endedEventId: string | null = null;
  if (open) {
    tx.update(jobAssignments)
      .set({ unassignedAt: now, unassignedByUserId: ctx.userId, unassignReason })
      .where(and(eq(jobAssignments.id, open.id), isNull(jobAssignments.unassignedAt)))
      .run();
    endedEventId = recordEvent(tx, ctx, {
      entityType: "assignment",
      entityId: open.id,
      jobId: loaded.id,
      eventType: "assignment.ended",
      action: "unassigned",
      previousValue: { userId: open.userId, role: "photographer", assignedAt: open.assignedAt },
      newValue: null,
      metadata: meta({ assignmentId: open.id, unassignReason, reason: p.reason ?? null }),
    });
  }
  let assignmentId: string | null = null;
  let createdEventId: string | null = null;
  if (p.userId) {
    assignmentId = newId();
    tx.insert(jobAssignments)
      .values({
        id: assignmentId,
        organisationId: ctx.organisationId,
        jobId: loaded.id,
        role: "photographer",
        userId: p.userId,
        assignedByUserId: ctx.userId,
        assignedAt: now,
        reason: p.reason ?? null,
        statusCategoryAtAssign: loaded.statusCategory,
      })
      .run();
    createdEventId = recordEvent(tx, ctx, {
      entityType: "assignment",
      entityId: assignmentId,
      jobId: loaded.id,
      eventType: "assignment.created",
      action: "assigned",
      previousValue: previous ? { userId: previous } : null,
      newValue: { userId: p.userId, role: "photographer" },
      metadata: meta({ assignmentId, reason: p.reason ?? null, statusCategory: loaded.statusCategory }),
    });
    tx.update(jobAssignments).set({ activityEventId: createdEventId }).where(eq(jobAssignments.id, assignmentId)).run();
  }
  const job = updateJobRow(tx, ctx, loaded, { photographerId: p.userId });
  if (p.userId && createdEventId) {
    notify(tx, ctx, {
      userIds: [p.userId],
      type: "job_assigned",
      title: `You are the photographer on ${job.jobNumber}`,
      body: job.name,
      jobId: job.id,
      activityEventId: createdEventId,
      linkPath: jobLinkPath(job.id),
    });
    emitAutomationEvent(tx, ctx, { eventId: createdEventId, eventType: "assignment.created", jobId: job.id });
  }
  if (previous && endedEventId) {
    notify(tx, ctx, {
      userIds: [previous],
      type: p.userId ? "job_reassigned" : "job_unassigned",
      title: p.userId ? `${job.jobNumber} has a new photographer` : `You were removed from ${job.jobNumber}`,
      body: job.name,
      jobId: job.id,
      activityEventId: createdEventId ?? endedEventId,
      linkPath: jobLinkPath(job.id),
    });
  }
  return { job, changed: true, previousPhotographerId: previous, assignmentId };
}

/** `POST /api/jobs/:id/assign { role, userId | null, reason, expectedVersion }`. */
export function assignRole(tx: Tx, ctx: AuthContext, input: unknown): AssignEditorResult | AssignPhotographerResult {
  const p = parseInput(AssignInput, input);
  const { role, ...rest } = p;
  return role === "editor" ? assignEditor(tx, ctx, rest) : assignPhotographer(tx, ctx, rest);
}

/**
 * `POST /api/jobs/bulk/reassign` — one transaction per job, one batchId,
 * no expectedVersion; HTTP 200 with `BulkResult` even when some fail.
 */
export function bulkReassign(ctx: AuthContext, input: unknown, options: { db?: Db } = {}): BulkResult {
  assertCan(ctx, "job.bulk_reassign");
  const p = parseInput(BulkReassignInput, input);
  return runPerJob(
    p.jobIds,
    (tx, jobId, batchId) => {
      const { job, ref } = loadVisibleJob(tx, ctx, jobId);
      assertCan(ctx, "job.assign_editor", ref);
      const result = assignEditorToJob(tx, ctx, job, p.userId, { reason: p.reason, batchId });
      if (!result.changed) {
        throw new ValidationError(p.userId ? "The job is already assigned to that editor" : "The job has no editor");
      }
    },
    { ...options, organisationId: ctx.organisationId },
  );
}
