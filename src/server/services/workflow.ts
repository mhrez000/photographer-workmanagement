/**
 * Workflow engine (ARCHITECTURE.md §4) — the ONLY writer of `jobs.status_id`.
 *
 * `transitionJobStatus()` implements §4.3 exactly:
 *   1. parse, load the job (404 for foreign / invisible), resolve the target
 *      status inside the job's workflow (by id, or by category)
 *   2. optimistic concurrency (409 with the current row)
 *   3. edge lookup through `allowedMoves()` (src/lib/workflow.ts) so the
 *      server and the UI buttons/kanban agree; generated cancel edges,
 *      lateral same-category moves and the computed restore are included;
 *      `override` (owner/manager, reason required) bypasses the graph
 *   4. actor checks (edge roles, own / assigned / assigneeOnly, requiresAssignedEditor)
 *   5. guards by target category (active editor, revision payload, reasons)
 *   6. ledger order enforced by triggers: close the open transition →
 *      insert the new transition row → UPDATE jobs (version + 1)
 *   7. side effects per target category (§4.4)
 *   8. `job.status_changed` (+ milestone event) with `metadata.transitionId`;
 *      `transition.activity_event_id` is set while the row is still open
 *   9. notifications (§6) and the automation hook, all inside the same tx
 *
 * Also exported for the assignment / jobs / revisions services (same tx):
 * `swapEditor` (editor ledger swap), `reattributeStage` (reassign mid-stage),
 * `applyMove` (engine-internal / restore / withdraw moves),
 * `closeRunningSessions`, `updateJobRow` (version-checked jobs UPDATE).
 *
 * Every function here is synchronous: better-sqlite3 transactions cannot be async.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, type Db, type DbLike, type Tx } from "@/db/index";
import {
  jobLinks,
  jobNotes,
  jobRevisions,
  jobStatusTransitions,
  jobAssignments,
  jobs,
  organisationSettings,
  users,
  workSessions,
  workflowStatuses,
  workflowTransitions,
} from "@/db/schema";
import {
  BOTTLENECK_DEFAULTS,
  CATEGORY_GROUPS,
  type EventAction,
  type EventCause,
  type EventType,
  type KanbanColumn,
  type LinkKind,
  type NotificationType,
  type SessionEndReason,
  type StatusCategory,
  type UnassignReason,
} from "@/lib/constants";
import { newId, shortId } from "@/lib/ids";
import { durationSeconds } from "@/lib/metrics";
import type { AuthContext, BulkResult, Job, JobAvailableActions, JobPermissionRef, StatusRef, WorkflowStatus } from "@/lib/types";
import {
  CancelInput,
  CategoryMoveInput,
  MigrateWorkflowInput,
  ReopenInput,
  RestoreInput,
  TransitionInput,
  optionalDeadlineToIso,
  type RevisionInputValue,
} from "@/lib/validation/jobs";
import {
  EDITOR_REQUIRED_CATEGORIES,
  actionForMove,
  allowedKanbanColumns,
  allowedMoves,
  availableActions,
  edgeDenialReason,
  findEdge,
  generateCancelEdges,
  isActiveCategory,
  isEditorWorking,
  isLateral,
  resolveTargetStatus,
  restoreTargetOf,
  type AllowedMove,
  type EdgeLike,
  type WorkflowJobLike,
} from "@/lib/workflow";
import { assertCan, can } from "@/server/auth/permissions";
import { recordEvent } from "@/server/audit";
import {
  AmbiguousTargetError,
  AppError,
  ConflictError,
  EditorRequiredError,
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
  ValidationError,
} from "@/server/errors";
import {
  assertVersion,
  jobPermissionRef,
  loadJobInOrg,
  loadPastEditorIds,
  loadStatusInWorkflow,
  loadUserInOrg,
  loadWorkflowInOrg,
  parseInput,
  runAutomationsAfterCommit,
  statusRef,
  withTx,
} from "./_shared";
import { managersOf, notify } from "./notifications";
import { closeRunningSessionForUser, closeSessionsForJob, startTimer, type WorkSessionClosedBy } from "./timeTracking";

/* ------------------------------------------------------------------ */
/*  Automation hook                                                    */
/* ------------------------------------------------------------------ */

/** An event that may trigger automations (§7). */
export interface AutomationTriggerEvent {
  eventId: string;
  eventType: EventType;
  jobId: string | null;
}

export type AutomationEnqueuer = (tx: Tx, ctx: AuthContext, event: AutomationTriggerEvent) => void;

let automationEnqueuer: AutomationEnqueuer | null = null;

/**
 * Registered by the automation engine (`enqueueAutomations`). Called inside
 * the mutation's transaction for every trigger-relevant event written by the
 * job / workflow / assignment / revision services. No-op until registered.
 */
export function setAutomationEnqueuer(fn: AutomationEnqueuer | null): void {
  automationEnqueuer = fn;
}

export function emitAutomationEvent(tx: Tx, ctx: AuthContext, event: AutomationTriggerEvent): void {
  if (automationEnqueuer) automationEnqueuer(tx, ctx, event);
}

/* ------------------------------------------------------------------ */
/*  Small shared helpers                                               */
/* ------------------------------------------------------------------ */

/** Columns any service may patch through `updateJobRow` (identity / audit columns excluded). */
export type JobPatch = Partial<
  Omit<typeof jobs.$inferInsert, "id" | "organisationId" | "jobNumber" | "createdByUserId" | "createdAt" | "version" | "updatedAt" | "lastActivityAt">
>;

/**
 * `UPDATE jobs SET …, version = version + 1 WHERE id = ? AND version = ?`.
 * Zero rows → 409 ConflictError carrying the current row.
 */
export function updateJobRow(tx: Tx, ctx: AuthContext, job: Job, patch: JobPatch): Job {
  const row = tx
    .update(jobs)
    .set({ ...patch, version: job.version + 1, updatedAt: ctx.now() })
    .where(and(eq(jobs.id, job.id), eq(jobs.organisationId, job.organisationId), eq(jobs.version, job.version)))
    .returning()
    .get();
  if (!row) {
    const current = tx.select().from(jobs).where(eq(jobs.id, job.id)).get();
    throw new ConflictError(undefined, current);
  }
  return row;
}

/** Event metadata extras every job event carries. */
export function jobEventMeta(job: Pick<Job, "jobNumber" | "name">, extra: Record<string, unknown> = {}, batchId?: string | null): Record<string, unknown> {
  return { jobNumber: job.jobNumber, jobName: job.name, ...(batchId ? { batchId } : {}), ...extra };
}

export function jobLinkPath(jobId: string, hash?: string): string {
  return hash ? `/jobs/${jobId}#${hash}` : `/jobs/${jobId}`;
}

function sendJobNotification(
  tx: Tx,
  ctx: AuthContext,
  job: Job,
  type: NotificationType,
  userIds: readonly (string | null | undefined)[],
  title: string,
  activityEventId: string | null,
  hash?: string,
): void {
  notify(tx, ctx, {
    userIds,
    type,
    title,
    body: job.name,
    jobId: job.id,
    activityEventId,
    linkPath: jobLinkPath(job.id, hash),
  });
}

function userNames(db: DbLike, ids: readonly (string | null | undefined)[]): Map<string, string> {
  const list = Array.from(new Set(ids.filter((id): id is string => typeof id === "string")));
  if (list.length === 0) return new Map();
  return new Map(
    db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, list))
      .all()
      .map((u) => [u.id, u.name]),
  );
}

export function isUserActive(db: DbLike, userId: string | null | undefined): boolean {
  if (!userId) return false;
  const row = db.select({ isActive: users.isActive }).from(users).where(eq(users.id, userId)).get();
  return row?.isActive === true;
}

function statusLog(s: Pick<WorkflowStatus, "id" | "name" | "category">): { statusId: string; statusName: string; category: StatusCategory } {
  return { statusId: s.id, statusName: s.name, category: s.category };
}

/* ------------------------------------------------------------------ */
/*  Loading                                                            */
/* ------------------------------------------------------------------ */

export interface VisibleJob {
  job: Job;
  ref: JobPermissionRef;
}

/** Job in the actor's org that the actor may view; otherwise 404 (existence never leaks). */
export function loadVisibleJob(db: DbLike, ctx: AuthContext, jobId: string): VisibleJob {
  const job = loadJobInOrg(db, ctx, jobId);
  const ref = jobPermissionRef(job, ctx.role === "editor" ? loadPastEditorIds(db, job.id) : undefined);
  if (!can(ctx, "job.view", ref)) throw new NotFoundError("Job");
  return { job, ref };
}

/** The job shape the pure workflow helpers need. */
export function toWorkflowJob(db: DbLike, job: Job, ref?: JobPermissionRef): WorkflowJobLike {
  return {
    ...(ref ?? jobPermissionRef(job)),
    statusId: job.statusId,
    previousStatusId: job.previousStatusId,
    editorIsActive: job.editorId ? isUserActive(db, job.editorId) : undefined,
  };
}

export interface WorkflowGraph {
  /** Every status of the workflow, archived included (history references them). */
  statuses: WorkflowStatus[];
  /** Every edge of the workflow, archived included (helpers filter). */
  edges: EdgeLike[];
}

export function loadWorkflowGraph(db: DbLike, organisationId: string, workflowId: string): WorkflowGraph {
  const statuses = db
    .select()
    .from(workflowStatuses)
    .where(and(eq(workflowStatuses.workflowId, workflowId), eq(workflowStatuses.organisationId, organisationId)))
    .orderBy(asc(workflowStatuses.sortOrder))
    .all();
  const edges: EdgeLike[] = db
    .select()
    .from(workflowTransitions)
    .where(and(eq(workflowTransitions.workflowId, workflowId), eq(workflowTransitions.organisationId, organisationId)))
    .all();
  return { statuses, edges };
}

function statusIn(graph: WorkflowGraph, id: string): WorkflowStatus {
  const s = graph.statuses.find((x) => x.id === id);
  if (!s) throw new NotFoundError("Status");
  return s;
}

/**
 * Moves the system context (automations / sweep) may make: explicit edges
 * (not engine-internal), the generated cancel edge and lateral moves. The
 * system allowlist covers `job.transition`, not the per-move matrix actions.
 */
function systemMoves(ctx: AuthContext, job: WorkflowJobLike, graph: WorkflowGraph): AllowedMove[] {
  const current = graph.statuses.find((s) => s.id === job.statusId);
  if (!current || current.category === "cancelled" || !can(ctx, "job.transition", job)) return [];
  const moves: AllowedMove[] = [];
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.archivedAt !== null || edge.fromStatusId !== current.id) continue;
    const to = graph.statuses.find((s) => s.id === edge.toStatusId);
    if (!to || to.archivedAt !== null || seen.has(to.id)) continue;
    if (actionForMove(ctx, current.category, to.category, edge.isReopen) === null) continue;
    if (edgeDenialReason(ctx, job, edge) !== null) continue;
    const isReopen = edge.isReopen || (current.category === "completed" && to.category !== "completed");
    seen.add(to.id);
    moves.push({
      toStatus: to,
      edge,
      label: edge.label ?? to.name,
      isReopen,
      isRestore: false,
      isLateral: isLateral(current, to),
      requiresRevisionPayload: to.category === "revision",
      requiresReason: to.category === "cancelled" || isReopen,
    });
  }
  if (isActiveCategory(current.category)) {
    for (const edge of generateCancelEdges(graph.statuses)) {
      if (edge.fromStatusId !== current.id || seen.has(edge.toStatusId)) continue;
      const to = statusIn(graph, edge.toStatusId);
      seen.add(to.id);
      moves.push({ toStatus: to, edge: null, label: "Cancel", isReopen: false, isRestore: false, isLateral: false, requiresRevisionPayload: false, requiresReason: true });
    }
  }
  for (const s of graph.statuses) {
    if (s.archivedAt !== null || seen.has(s.id) || !isLateral(current, s) || current.category === "completed") continue;
    moves.push({ toStatus: s, edge: null, label: `Move to ${s.name}`, isReopen: false, isRestore: false, isLateral: true, requiresRevisionPayload: false, requiresReason: false });
  }
  return moves;
}

/** Moves the actor may make right now (same list the UI renders as buttons). */
export function movesFor(ctx: AuthContext, job: WorkflowJobLike, graph: WorkflowGraph): AllowedMove[] {
  return ctx.isSystem ? systemMoves(ctx, job, graph) : allowedMoves(ctx, job, graph.statuses, graph.edges);
}

/**
 * Target status inside the job's workflow (§4.3 step 1). By id: foreign /
 * other-workflow / archived → 404. By category: the single allowed move into
 * that category; several → 422 AmbiguousTarget; none → the lowest-sortOrder
 * status of the category (the move check then explains why it is not allowed).
 */
export function resolveTransitionTarget(
  db: DbLike,
  ctx: AuthContext,
  job: Job,
  graph: WorkflowGraph,
  target: { toStatusId?: string | null; toCategory?: StatusCategory | null },
): WorkflowStatus {
  if (target.toStatusId) {
    const s = loadStatusInWorkflow(db, ctx, job.workflowId, target.toStatusId);
    if (s.archivedAt !== null) throw new NotFoundError("Status");
    return s;
  }
  const category = target.toCategory;
  if (!category) throw new NotFoundError("Status");
  const ref = jobPermissionRef(job, ctx.role === "editor" ? loadPastEditorIds(db, job.id) : undefined);
  const candidates = movesFor(ctx, toWorkflowJob(db, job, ref), graph).filter((m) => m.toStatus.category === category);
  if (candidates.length === 1) return statusIn(graph, candidates[0].toStatus.id);
  if (candidates.length > 1) {
    throw new AmbiguousTargetError(candidates.map((m) => ({ id: m.toStatus.id, name: m.toStatus.name, key: m.toStatus.key })));
  }
  return statusIn(graph, resolveTargetStatus(graph.statuses, { toCategory: category }).id);
}

/** Lowest `ready` status, else the initial status (unassign / restore fallback). */
export function unassignedTargetOf(graph: WorkflowGraph): WorkflowStatus {
  const live = graph.statuses.filter((s) => s.archivedAt === null);
  const ready = live.filter((s) => s.category === "ready").sort((a, b) => a.sortOrder - b.sortOrder)[0];
  const target = ready ?? live.find((s) => s.isInitial);
  if (!target) throw new NotFoundError("Status", "This workflow has no ready or initial status");
  return target;
}

/* ------------------------------------------------------------------ */
/*  Work sessions (time tracking side effects)                         */
/* ------------------------------------------------------------------ */

/**
 * Closes running sessions through the time-tracking engine hooks
 * (`closeSessionsForJob` / `closeRunningSessionForUser`, which audit each
 * `work_session.ended`). `{ jobId }` closes every session on the job;
 * `{ jobId, userId }` closes that user's running session only when it is on
 * this job; `{ userId }` closes the user's running session wherever it is.
 * Returns the closed session ids.
 */
export function closeRunningSessions(
  tx: Tx,
  ctx: AuthContext,
  filter: { jobId?: string; userId?: string },
  endReason: SessionEndReason,
  closedBy: WorkSessionClosedBy,
  batchId?: string | null,
): string[] {
  const opts = { closedBy, ...(batchId ? { metadata: { batchId } } : {}) };
  if (filter.userId) {
    if (filter.jobId) {
      const running = tx
        .select({ id: workSessions.id })
        .from(workSessions)
        .where(and(eq(workSessions.userId, filter.userId), eq(workSessions.jobId, filter.jobId), isNull(workSessions.endedAt)))
        .get();
      if (!running) return [];
    }
    const closed = closeRunningSessionForUser(tx, ctx, filter.userId, endReason, opts);
    return closed ? [closed.id] : [];
  }
  if (!filter.jobId) return [];
  return closeSessionsForJob(tx, ctx, filter.jobId, endReason, opts).map((r) => r.id);
}

/* ------------------------------------------------------------------ */
/*  Editor ledger swap (used by assignments + revision requests)       */
/* ------------------------------------------------------------------ */

export interface SwapEditorOptions {
  reason?: string | null;
  /** Reason stored on the closed assignment. Default: reassigned (replacing) / unassigned (removing). */
  unassignReason?: UnassignReason;
  batchId?: string | null;
  /** Notify the old editor (job_reassigned / job_unassigned). Default true. */
  notifyOld?: boolean;
}

export interface SwapEditorResult {
  job: Job;
  previousEditorId: string | null;
  /** New open assignment row (null when unassigning). */
  assignmentId: string | null;
  endedAssignmentId: string | null;
  createdEventId: string | null;
  endedEventId: string | null;
}

/**
 * Replaces the job's editor in the assignment ledger WITHOUT touching the
 * status (§4.5 building block): closes the open editor assignment, closes
 * the old editor's running session on this job, opens the new assignment,
 * re-points the open revision's assignee, sets `editor_id` /
 * `previous_editor_id`, audits `assignment.ended` / `assignment.created`
 * and notifies. Callers check permissions and validate the target user.
 */
export function swapEditor(tx: Tx, ctx: AuthContext, jobIn: Job, newEditorId: string | null, opts: SwapEditorOptions = {}): SwapEditorResult {
  let job = jobIn;
  const oldEditorId = job.editorId;
  const none: SwapEditorResult = { job, previousEditorId: oldEditorId, assignmentId: null, endedAssignmentId: null, createdEventId: null, endedEventId: null };
  if (oldEditorId === newEditorId) return none;
  const now = ctx.now();
  const names = userNames(tx, [oldEditorId, newEditorId]);
  const unassignReason: UnassignReason = opts.unassignReason ?? (newEditorId ? "reassigned" : "unassigned");
  const meta = (extra: Record<string, unknown>) => jobEventMeta(job, extra, opts.batchId);

  let endedAssignmentId: string | null = null;
  let endedEventId: string | null = null;
  const open = tx
    .select()
    .from(jobAssignments)
    .where(and(eq(jobAssignments.jobId, job.id), eq(jobAssignments.role, "editor"), isNull(jobAssignments.unassignedAt)))
    .get();
  if (open) {
    tx.update(jobAssignments)
      .set({ unassignedAt: now, unassignedByUserId: ctx.userId, unassignReason })
      .where(and(eq(jobAssignments.id, open.id), isNull(jobAssignments.unassignedAt)))
      .run();
    endedAssignmentId = open.id;
    endedEventId = recordEvent(tx, ctx, {
      entityType: "assignment",
      entityId: open.id,
      jobId: job.id,
      eventType: "assignment.ended",
      action: "unassigned",
      previousValue: { userId: open.userId, role: "editor", assignedAt: open.assignedAt, userName: names.get(open.userId) ?? null },
      newValue: null,
      metadata: meta({ assignmentId: open.id, unassignReason, reason: opts.reason ?? null }),
    });
    const sessionReason: SessionEndReason = unassignReason === "user_deactivated" ? "auto_deactivated" : "auto_reassigned";
    closeRunningSessions(tx, ctx, { jobId: job.id, userId: open.userId }, sessionReason, unassignReason === "user_deactivated" ? "deactivate" : "reassign", opts.batchId);
  }

  let assignmentId: string | null = null;
  let createdEventId: string | null = null;
  if (newEditorId) {
    assignmentId = newId();
    tx.insert(jobAssignments)
      .values({
        id: assignmentId,
        organisationId: ctx.organisationId,
        jobId: job.id,
        role: "editor",
        userId: newEditorId,
        assignedByUserId: ctx.userId,
        assignedAt: now,
        reason: opts.reason ?? null,
        statusCategoryAtAssign: job.statusCategory,
      })
      .run();
    createdEventId = recordEvent(tx, ctx, {
      entityType: "assignment",
      entityId: assignmentId,
      jobId: job.id,
      eventType: "assignment.created",
      action: "assigned",
      previousValue: oldEditorId ? { userId: oldEditorId, userName: names.get(oldEditorId) ?? null } : null,
      newValue: { userId: newEditorId, role: "editor", userName: names.get(newEditorId) ?? null },
      metadata: meta({ assignmentId, reason: opts.reason ?? null, statusCategory: job.statusCategory }),
    });
    tx.update(jobAssignments).set({ activityEventId: createdEventId }).where(eq(jobAssignments.id, assignmentId)).run();
  }

  // Re-point the open revision (assignee is editable while open).
  const openRevision = tx
    .select()
    .from(jobRevisions)
    .where(and(eq(jobRevisions.jobId, job.id), isNull(jobRevisions.resolvedAt)))
    .get();
  let repointedEventId: string | null = null;
  if (openRevision && openRevision.assigneeUserId !== newEditorId) {
    tx.update(jobRevisions).set({ assigneeUserId: newEditorId }).where(and(eq(jobRevisions.id, openRevision.id), isNull(jobRevisions.resolvedAt))).run();
    repointedEventId = recordEvent(tx, ctx, {
      entityType: "revision",
      entityId: openRevision.id,
      jobId: job.id,
      eventType: "revision.updated",
      action: "updated",
      previousValue: { assigneeUserId: openRevision.assigneeUserId },
      newValue: { assigneeUserId: newEditorId },
      metadata: meta({ revisionId: openRevision.id, revisionNumber: openRevision.revisionNumber, reassigned: true }),
    });
  }

  job = updateJobRow(tx, ctx, job, {
    editorId: newEditorId,
    previousEditorId: oldEditorId ?? job.previousEditorId,
  });

  if (newEditorId) {
    if (openRevision && repointedEventId) {
      // The new editor inherits an open revision: tell them what to fix (mandatory
      // revision_requested, §6) instead of a generic job_assigned.
      notify(tx, ctx, {
        userIds: [newEditorId],
        type: "revision_requested",
        title: `Revision #${openRevision.revisionNumber} on ${job.jobNumber} is now assigned to you`,
        body: [openRevision.reason, openRevision.instructions].filter((s): s is string => typeof s === "string" && s.trim() !== "").join(" — ") || job.name,
        jobId: job.id,
        activityEventId: repointedEventId,
        linkPath: jobLinkPath(job.id, `revision-${openRevision.revisionNumber}`),
      });
    } else {
      sendJobNotification(tx, ctx, job, "job_assigned", [newEditorId], `${job.jobNumber} was assigned to you`, createdEventId);
    }
    if (createdEventId) emitAutomationEvent(tx, ctx, { eventId: createdEventId, eventType: "assignment.created", jobId: job.id });
  }
  if (oldEditorId && opts.notifyOld !== false) {
    if (newEditorId) {
      sendJobNotification(tx, ctx, job, "job_reassigned", [oldEditorId], `${job.jobNumber} was reassigned`, createdEventId ?? endedEventId);
    } else {
      sendJobNotification(tx, ctx, job, "job_unassigned", [oldEditorId], `You were unassigned from ${job.jobNumber}`, endedEventId);
    }
  }

  return { job, previousEditorId: oldEditorId, assignmentId, endedAssignmentId, createdEventId, endedEventId };
}

/* ------------------------------------------------------------------ */
/*  Stage re-attribution (reassign mid-stage, §4.5)                    */
/* ------------------------------------------------------------------ */

export interface ReattributeResult {
  job: Job;
  transitionId: string;
  previousTransitionId: string;
  eventId: string;
}

/**
 * Closes the open transition row and inserts a `kind='reattribution'` row
 * with the same from/to status and category, `editor_id_at_entry` = the
 * job's (new) editor and `reason = "reassigned"`. Status unchanged;
 * `status_entered_at` follows the open row (db:verify invariant).
 */
export function reattributeStage(tx: Tx, ctx: AuthContext, jobIn: Job, opts: { previousEditorId: string | null; batchId?: string | null }): ReattributeResult {
  const now = ctx.now();
  const open = loadOpenTransition(tx, jobIn.id);
  const duration = durationSeconds(open.enteredAt, now, now);
  tx.update(jobStatusTransitions)
    .set({ exitedAt: now, durationSeconds: duration })
    .where(and(eq(jobStatusTransitions.id, open.id), isNull(jobStatusTransitions.exitedAt)))
    .run();
  const transitionId = newId();
  tx.insert(jobStatusTransitions)
    .values({
      id: transitionId,
      organisationId: ctx.organisationId,
      jobId: jobIn.id,
      sequence: nextSequence(tx, jobIn.id),
      kind: "reattribution",
      fromStatusId: open.fromStatusId,
      toStatusId: open.toStatusId,
      fromCategory: open.fromCategory,
      toCategory: open.toCategory,
      statusName: open.statusName,
      actorUserId: ctx.userId,
      automationRunId: ctx.automationRunId ?? null,
      reason: "reassigned",
      isReopen: false,
      isOverride: false,
      enteredAt: now,
      editorIdAtEntry: jobIn.editorId,
      photographerIdAtEntry: jobIn.photographerId,
    })
    .run();
  const job = updateJobRow(tx, ctx, jobIn, { statusEnteredAt: now });
  const names = userNames(tx, [opts.previousEditorId, job.editorId]);
  const eventId = recordEvent(tx, ctx, {
    entityType: "transition",
    entityId: transitionId,
    jobId: job.id,
    eventType: "job.stage_reattributed",
    action: "updated",
    previousValue: { editorId: opts.previousEditorId },
    newValue: { editorId: job.editorId, editorName: job.editorId ? (names.get(job.editorId) ?? null) : null },
    metadata: jobEventMeta(
      job,
      {
        transitionId,
        previousTransitionId: open.id,
        category: open.toCategory,
        durationInPreviousSeconds: duration,
        toEditorName: job.editorId ? (names.get(job.editorId) ?? null) : null,
      },
      opts.batchId,
    ),
  });
  tx.update(jobStatusTransitions).set({ activityEventId: eventId }).where(eq(jobStatusTransitions.id, transitionId)).run();
  return { job, transitionId, previousTransitionId: open.id, eventId };
}

/* ------------------------------------------------------------------ */
/*  Ledger primitives                                                  */
/* ------------------------------------------------------------------ */

function loadOpenTransition(db: DbLike, jobId: string) {
  const open = db
    .select()
    .from(jobStatusTransitions)
    .where(and(eq(jobStatusTransitions.jobId, jobId), isNull(jobStatusTransitions.exitedAt)))
    .get();
  if (!open) throw new Error(`Integrity error: job ${jobId} has no open status transition`);
  return open;
}

function nextSequence(db: DbLike, jobId: string): number {
  const row = db
    .select({ n: sql<number>`coalesce(max(${jobStatusTransitions.sequence}), 0)` })
    .from(jobStatusTransitions)
    .where(eq(jobStatusTransitions.jobId, jobId))
    .get();
  return (row?.n ?? 0) + 1;
}

function currentLinkIds(db: DbLike, jobId: string, kinds: readonly LinkKind[]): string[] {
  return db
    .select({ id: jobLinks.id })
    .from(jobLinks)
    .where(and(eq(jobLinks.jobId, jobId), inArray(jobLinks.kind, [...kinds]), isNull(jobLinks.supersededAt), isNull(jobLinks.removedAt)))
    .all()
    .map((r) => r.id);
}

interface ResolvedRevision {
  revisionId: string;
  revisionNumber: number;
  requestedByUserId: string;
  eventId: string;
}

/** Fill-once resolution of the job's open revision (if any). */
function resolveOpenRevision(
  tx: Tx,
  ctx: AuthContext,
  job: Job,
  resolution: "resubmitted" | "withdrawn" | "approved" | "cancelled",
  opts: { transitionId: string | null; note?: string | null; batchId?: string | null },
): ResolvedRevision | null {
  const open = tx
    .select()
    .from(jobRevisions)
    .where(and(eq(jobRevisions.jobId, job.id), isNull(jobRevisions.resolvedAt)))
    .get();
  if (!open) return null;
  const now = ctx.now();
  tx.update(jobRevisions)
    .set({
      resolvedAt: now,
      resolvedByUserId: ctx.userId,
      resolution,
      resolutionNote: opts.note ?? null,
      resolveTransitionId: opts.transitionId,
    })
    .where(and(eq(jobRevisions.id, open.id), isNull(jobRevisions.resolvedAt)))
    .run();
  const withdrawn = resolution === "withdrawn";
  const eventId = recordEvent(tx, ctx, {
    entityType: "revision",
    entityId: open.id,
    jobId: job.id,
    eventType: withdrawn ? "revision.withdrawn" : "revision.resolved",
    action: withdrawn ? "withdrawn" : "resolved",
    previousValue: { resolvedAt: null },
    newValue: { resolvedAt: now, resolvedByUserId: ctx.userId, resolution, resolutionNote: opts.note ?? null },
    metadata: jobEventMeta(job, { revisionId: open.id, revisionNumber: open.revisionNumber, transitionId: opts.transitionId }, opts.batchId),
  });
  return { revisionId: open.id, revisionNumber: open.revisionNumber, requestedByUserId: open.requestedByUserId, eventId };
}

function loadSlaHours(db: DbLike, organisationId: string): number {
  const row = db
    .select({ h: organisationSettings.reviewSlaHours })
    .from(organisationSettings)
    .where(eq(organisationSettings.organisationId, organisationId))
    .get();
  return row?.h ?? BOTTLENECK_DEFAULTS.reviewSlaHours;
}

/* ------------------------------------------------------------------ */
/*  applyMove — the engine                                             */
/* ------------------------------------------------------------------ */

/**
 * - user: an actor-initiated move, checked against `movesFor()` (or `override`)
 * - internal: engine-internal move made by the assignment service (→ assigned,
 *   unassign → ready); the caller already checked `job.assign_editor`
 * - restore: cancelled → computed restore target (`job.restore`)
 * - withdraw: revision → status before the request (revisions service checked `revision.withdraw`)
 */
export type MoveMode = "user" | "internal" | "restore" | "withdraw";

export interface ApplyMoveOptions {
  mode: MoveMode;
  reason?: string | null;
  override?: boolean;
  revision?: RevisionInputValue | null;
  startTimer?: boolean;
  batchId?: string | null;
  /** Resolution note for the revision resolved by this move (resubmit / withdraw). */
  resolutionNote?: string | null;
  /** System contexts only: `metadata.cause` on the events. */
  cause?: EventCause;
}

export interface TransitionResult {
  job: Job;
  transitionId: string;
  /** The `job.status_changed` event. */
  eventId: string;
  fromStatus: StatusRef;
  toStatus: StatusRef;
  isOverride: boolean;
  isReopen: boolean;
  isRestore: boolean;
  isLateral: boolean;
  /** Revision created (→ revision) or resolved (resubmit / approve / cancel / withdraw) by this move. */
  revisionId: string | null;
  /** Non-blocking guard messages (e.g. submitted without a finished-files link). */
  warnings: string[];
}

const EDITOR_SIDE_TARGETS: readonly StatusCategory[] = ["accepted", "in_progress", "submitted", "resubmitted"];

function deniedError(ctx: AuthContext, job: WorkflowJobLike, current: WorkflowStatus, target: WorkflowStatus, graph: WorkflowGraph): AppError {
  const edge = findEdge(graph.edges, current.id, target.id);
  const lateral = isLateral(current, target);
  const isCancel = target.category === "cancelled";
  if (current.category === "cancelled") {
    return new InvalidTransitionError(current.name, target.name, "A cancelled job can only be restored to the status it was cancelled from");
  }
  if (!edge && !lateral && !isCancel) return new InvalidTransitionError(current.name, target.name);
  if (edge) {
    const reason = edgeDenialReason(ctx, job, edge);
    if (reason === "Assign an active editor first") return new EditorRequiredError();
    if (reason) return new ForbiddenError("job.transition", reason);
    const action = actionForMove(ctx, current.category, target.category, edge.isReopen);
    if (action === null) {
      return new InvalidTransitionError(current.name, target.name, `"${target.name}" is set by assigning or unassigning an editor`);
    }
    return new ForbiddenError(action);
  }
  if (isCancel) return isActiveCategory(current.category) ? new ForbiddenError("job.cancel") : new InvalidTransitionError(current.name, target.name);
  return new ForbiddenError("job.transition");
}

/**
 * Performs one status move on an already-loaded job (caller checked the
 * version for user input). See the module doc for the step order.
 */
export function applyMove(tx: Tx, ctx: AuthContext, jobIn: Job, targetIn: WorkflowStatus, graph: WorkflowGraph, opts: ApplyMoveOptions): TransitionResult {
  let job = jobIn;
  let target = targetIn;
  const before = jobIn;
  const current = statusIn(graph, job.statusId);
  if (target.archivedAt !== null) throw new NotFoundError("Status");
  if (target.workflowId !== job.workflowId) throw new NotFoundError("Status");
  if (target.id === current.id) throw new InvalidTransitionError(current.name, target.name, `The job is already in "${current.name}"`);

  const ref = jobPermissionRef(job, ctx.role === "editor" ? loadPastEditorIds(tx, job.id) : undefined);
  const wjob = toWorkflowJob(tx, job, ref);

  let isOverride = false;
  let isReopen = false;
  let isRestore = false;
  let lateral = isLateral(current, target);
  const withdraw = opts.mode === "withdraw";

  switch (opts.mode) {
    case "internal":
    case "withdraw":
      break;
    case "restore":
      if (current.category !== "cancelled") throw new InvalidTransitionError(current.name, target.name, "Only cancelled jobs can be restored");
      assertCan(ctx, "job.restore", ref);
      isRestore = true;
      break;
    case "user": {
      const move = movesFor(ctx, wjob, graph).find((m) => m.toStatus.id === target.id);
      if (move) {
        isReopen = move.isReopen;
        isRestore = move.isRestore;
        lateral = move.isLateral;
      } else if (opts.override) {
        assertCan(ctx, "job.transition_override", ref);
        isOverride = true;
        isReopen = current.category === "completed" && target.category !== "completed";
        isRestore = current.category === "cancelled";
      } else {
        throw deniedError(ctx, wjob, current, target, graph);
      }
      break;
    }
  }

  // ---- step 5: guards ----
  const reason = opts.reason?.trim() || opts.revision?.reason?.trim() || null;
  const needsReason = isOverride || isReopen || (opts.mode === "user" && target.category === "cancelled");
  if (needsReason && !reason) {
    throw new ValidationError("A reason is required for this change", { formErrors: [], fieldErrors: { reason: ["Required"] } });
  }
  const entersRevision = target.category === "revision" && !(lateral && current.category === "revision") && !withdraw;
  if (entersRevision && !opts.revision) {
    throw new ValidationError("A revision request needs a reason and a description", {
      formErrors: [],
      fieldErrors: { "revision.reason": ["Required"], "revision.description": ["Required"] },
    });
  }

  // Revision payload naming another editor → reassign first (same tx).
  const requestedAssignee = entersRevision ? (opts.revision?.assigneeUserId ?? null) : null;
  if (requestedAssignee && requestedAssignee !== job.editorId) {
    assertCan(ctx, "job.assign_editor", ref);
    const editor = loadUserInOrg(tx, ctx, requestedAssignee);
    if (!editor.isActive) throw new ValidationError("The revision assignee is deactivated");
    if (editor.role !== "editor") throw new ValidationError("The revision assignee must be an editor");
    job = swapEditor(tx, ctx, job, editor.id, { reason: "Revision assignee", batchId: opts.batchId }).job;
  }

  // Decline / unassign: entering new|ready drops the editor before the row is written.
  let declined = false;
  if (CATEGORY_GROUPS.UNASSIGNED.includes(target.category) && job.editorId && opts.mode !== "internal") {
    declined = ctx.userId !== null && ctx.userId === job.editorId && current.category === "assigned";
    job = swapEditor(tx, ctx, job, null, {
      unassignReason: declined ? "declined" : "unassigned",
      reason,
      batchId: opts.batchId,
      notifyOld: !declined,
    }).job;
  }

  // Restore into an editor stage whose editor is gone → back to ready instead.
  let releasedInactiveEditorId: string | null = null;
  if (isRestore && EDITOR_REQUIRED_CATEGORIES.includes(target.category) && !isUserActive(tx, job.editorId)) {
    if (job.editorId) {
      releasedInactiveEditorId = job.editorId;
      job = swapEditor(tx, ctx, job, null, { unassignReason: "user_deactivated", reason: "Editor unavailable on restore", batchId: opts.batchId }).job;
    }
    target = unassignedTargetOf(graph);
    lateral = false;
  }

  // Restore / reopen into an active stage that does not need a working editor
  // (submitted, review, approved, delivered, …) while the job's editor is
  // deactivated: the job would come back "held by an inactive editor" without
  // the deactivation's `kept` flag (that flag lives on the append-only
  // `user.deactivated` event and cannot be granted later), so the editor is
  // released exactly like a deactivation hand-off (`unassign_reason =
  // user_deactivated`); `previous_editor_id` keeps who did the work. Same
  // rule for restore and reopen. (Reopen into an editor-required stage is
  // still a 422 EditorRequired below.)
  if (
    (isRestore || isReopen) &&
    job.editorId &&
    !CATEGORY_GROUPS.TERMINAL.includes(target.category) &&
    !CATEGORY_GROUPS.UNASSIGNED.includes(target.category) &&
    !EDITOR_REQUIRED_CATEGORIES.includes(target.category) &&
    !isUserActive(tx, job.editorId)
  ) {
    releasedInactiveEditorId = job.editorId;
    job = swapEditor(tx, ctx, job, null, {
      unassignReason: "user_deactivated",
      reason: isRestore ? "Editor unavailable on restore" : "Editor unavailable on reopen",
      batchId: opts.batchId,
    }).job;
  }

  if (EDITOR_REQUIRED_CATEGORIES.includes(target.category) && !isUserActive(tx, job.editorId)) {
    throw new EditorRequiredError();
  }

  // ---- sessions: a running timer belongs to the stage it started in ----
  const closedBy: WorkSessionClosedBy =
    target.category === "submitted" || target.category === "resubmitted" ? "submit" : CATEGORY_GROUPS.TERMINAL.includes(target.category) ? "complete" : "status_change";
  closeRunningSessions(tx, ctx, { jobId: job.id }, "auto_status_change", closedBy, opts.batchId);

  // ---- step 6: ledger (close → insert → update jobs) ----
  const now = ctx.now();
  const open = loadOpenTransition(tx, job.id);
  const durationInPrevious = durationSeconds(open.enteredAt, now, now);
  tx.update(jobStatusTransitions)
    .set({ exitedAt: now, durationSeconds: durationInPrevious })
    .where(and(eq(jobStatusTransitions.id, open.id), isNull(jobStatusTransitions.exitedAt)))
    .run();
  const transitionId = newId();
  const sequence = nextSequence(tx, job.id);
  tx.insert(jobStatusTransitions)
    .values({
      id: transitionId,
      organisationId: ctx.organisationId,
      jobId: job.id,
      sequence,
      kind: "transition",
      fromStatusId: current.id,
      toStatusId: target.id,
      fromCategory: current.category,
      toCategory: target.category,
      statusName: target.name,
      actorUserId: ctx.userId,
      automationRunId: ctx.automationRunId ?? null,
      reason,
      isReopen,
      isOverride,
      enteredAt: now,
      editorIdAtEntry: job.editorId,
      photographerIdAtEntry: job.photographerId,
    })
    .run();

  const tz = ctx.settings.timezone;
  const patch: JobPatch = {
    statusId: target.id,
    statusCategory: target.category,
    previousStatusId: current.id,
    statusEnteredAt: now,
    isPaused: false,
    pausedAt: null,
    completedAt: target.category === "completed" ? now : null,
    cancelledAt: target.category === "cancelled" ? now : null,
  };

  // Revision created by this move.
  let revisionId: string | null = null;
  let revisionNumber: number | null = null;
  let staleRevision: ResolvedRevision | null = null;
  if (entersRevision && opts.revision) {
    staleRevision = resolveOpenRevision(tx, ctx, job, "withdrawn", {
      transitionId,
      note: "Superseded by a new revision request",
      batchId: opts.batchId,
    });
    const max = tx
      .select({ n: sql<number>`coalesce(max(${jobRevisions.revisionNumber}), 0)` })
      .from(jobRevisions)
      .where(eq(jobRevisions.jobId, job.id))
      .get();
    revisionNumber = (max?.n ?? 0) + 1;
    revisionId = newId();
    tx.insert(jobRevisions)
      .values({
        id: revisionId,
        organisationId: ctx.organisationId,
        jobId: job.id,
        revisionNumber,
        requestedByUserId: ctx.userId ?? job.createdByUserId,
        assigneeUserId: job.editorId,
        reason: opts.revision.reason,
        description: opts.revision.description,
        instructions: opts.revision.instructions ?? null,
        priority: opts.revision.priority ?? "normal",
        dueDate: optionalDeadlineToIso(opts.revision.dueDate, tz) ?? null,
        requestedAt: now,
        requestTransitionId: transitionId,
      })
      .run();
    patch.revisionCount = revisionNumber;
    patch.openRevisionId = revisionId;
  }

  // Revision resolved by this move.
  let resolved: ResolvedRevision | null = null;
  if (withdraw) {
    resolved = resolveOpenRevision(tx, ctx, job, "withdrawn", { transitionId, note: opts.resolutionNote, batchId: opts.batchId });
  } else if (target.category === "resubmitted") {
    resolved = resolveOpenRevision(tx, ctx, job, "resubmitted", { transitionId, note: opts.resolutionNote, batchId: opts.batchId });
  } else if (target.category === "approved") {
    resolved = resolveOpenRevision(tx, ctx, job, "approved", { transitionId, note: opts.resolutionNote, batchId: opts.batchId });
  } else if (target.category === "cancelled") {
    resolved = resolveOpenRevision(tx, ctx, job, "cancelled", { transitionId, note: reason, batchId: opts.batchId });
  }
  if (resolved || (staleRevision && !revisionId)) patch.openRevisionId = null;

  // Milestones per target category (§4.4). Withdraw / internal moves only move the pointers.
  const sideEffects = opts.mode !== "internal" && !withdraw;
  let reviewDueDefaulted: string | null = null;
  let firstStart = false;
  if (sideEffects) {
    switch (target.category) {
      case "in_progress":
        if (!job.startedAt) {
          patch.startedAt = now;
          firstStart = true;
        }
        patch.completionPercent = Math.max(job.completionPercent, 5);
        break;
      case "submitted":
        patch.firstSubmittedAt = job.firstSubmittedAt ?? now;
        patch.lastSubmittedAt = now;
        patch.completionPercent = Math.max(job.completionPercent, 90);
        if (!job.reviewDueDate) {
          reviewDueDefaulted = new Date(Date.parse(now) + loadSlaHours(tx, ctx.organisationId) * 3_600_000).toISOString();
          patch.reviewDueDate = reviewDueDefaulted;
        }
        break;
      case "resubmitted":
        patch.lastSubmittedAt = now;
        patch.completionPercent = Math.max(job.completionPercent, 90);
        break;
      case "approved":
        patch.approvedAt = now;
        patch.approvedByUserId = ctx.userId;
        patch.dueDateAtApproval = job.dueDate;
        patch.wasOnTime = job.dueDate === null ? null : Date.parse(now) <= Date.parse(job.dueDate);
        patch.completionPercent = 100;
        break;
      case "delivered":
        patch.deliveredAt = now;
        break;
      case "completed":
        patch.dueDateAtCompletion = job.dueDate;
        break;
      default:
        break;
    }
    if (isReopen) {
      patch.reopenedCount = job.reopenedCount + 1;
      patch.dueDateAtCompletion = null;
      if (target.category !== "approved") {
        patch.approvedAt = null;
        patch.approvedByUserId = null;
        patch.dueDateAtApproval = null;
        patch.wasOnTime = null;
      }
      if (target.category !== "delivered") patch.deliveredAt = null;
    }
  } else if (isReopen) {
    patch.reopenedCount = job.reopenedCount + 1;
  }

  job = updateJobRow(tx, ctx, job, patch);

  // ---- step 8: events ----
  const onBehalfOf =
    (ctx.role === "owner" || ctx.role === "manager") && !ctx.isSystem && EDITOR_SIDE_TARGETS.includes(target.category) && job.editorId && job.editorId !== ctx.userId
      ? job.editorId
      : undefined;
  const causeMeta = ctx.isSystem && opts.cause ? { cause: opts.cause } : {};
  const meta = (extra: Record<string, unknown>) => jobEventMeta(job, { ...extra, ...causeMeta }, opts.batchId);
  const statusEventId = recordEvent(tx, ctx, {
    entityType: "job",
    entityId: job.id,
    jobId: job.id,
    eventType: "job.status_changed",
    action: "transitioned",
    previousValue: statusLog(current),
    newValue: statusLog(target),
    metadata: meta({
      transitionId,
      sequence,
      reason,
      revisionId: revisionId ?? resolved?.revisionId ?? null,
      isOverride,
      isReopen,
      isRestore,
      lateral,
      withdrawal: withdraw,
      engineInternal: opts.mode === "internal",
      ...(onBehalfOf ? { onBehalfOf } : {}),
      ...(releasedInactiveEditorId ? { releasedInactiveEditorId, releaseReason: "editor_deactivated" } : {}),
      durationInPreviousSeconds: durationInPrevious,
    }),
  });
  tx.update(jobStatusTransitions).set({ activityEventId: statusEventId }).where(eq(jobStatusTransitions.id, transitionId)).run();
  emitAutomationEvent(tx, ctx, { eventId: statusEventId, eventType: "job.status_changed", jobId: job.id });

  const milestone = (eventType: EventType, action: EventAction, extra: Record<string, unknown> = {}, prev?: unknown, next?: unknown) =>
    recordEvent(tx, ctx, {
      entityType: "job",
      entityId: job.id,
      jobId: job.id,
      eventType,
      action,
      previousValue: prev ?? { statusId: current.id, category: current.category },
      newValue: next ?? { statusId: target.id, category: target.category },
      metadata: meta({ transitionId, ...extra }),
    });

  const warnings: string[] = [];
  const photographerAndCreator = [job.photographerId, job.createdByUserId];

  if (reviewDueDefaulted) {
    const evt = recordEvent(tx, ctx, {
      entityType: "job",
      entityId: job.id,
      jobId: job.id,
      eventType: "job.review_due_date_changed",
      action: "updated",
      previousValue: { value: null },
      newValue: { value: reviewDueDefaulted },
      metadata: jobEventMeta(job, { cause: "sla_default", transitionId, wasOverdue: false }, opts.batchId),
    });
    emitAutomationEvent(tx, ctx, { eventId: evt, eventType: "job.review_due_date_changed", jobId: job.id });
  }

  if (revisionId && revisionNumber !== null && opts.revision) {
    const p = opts.revision;
    const revEvent = recordEvent(tx, ctx, {
      entityType: "revision",
      entityId: revisionId,
      jobId: job.id,
      eventType: "revision.requested",
      action: "requested",
      previousValue: null,
      newValue: {
        revisionNumber,
        reason: p.reason,
        description: p.description,
        instructions: p.instructions ?? null,
        priority: p.priority ?? "normal",
        dueDate: optionalDeadlineToIso(p.dueDate, tz) ?? null,
        assigneeUserId: job.editorId,
      },
      metadata: meta({ revisionId, transitionId, revisionNumber }),
    });
    tx.update(jobRevisions).set({ activityEventId: revEvent }).where(eq(jobRevisions.id, revisionId)).run();
    if (p.instructions) {
      const noteId = newId();
      tx.insert(jobNotes)
        .values({
          id: noteId,
          organisationId: ctx.organisationId,
          jobId: job.id,
          kind: "revision",
          body: p.instructions,
          authorUserId: ctx.userId ?? job.createdByUserId,
          revisionId,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      recordEvent(tx, ctx, {
        entityType: "note",
        entityId: noteId,
        jobId: job.id,
        eventType: "note.added",
        action: "created",
        previousValue: null,
        newValue: { kind: "revision", body: p.instructions },
        metadata: meta({ noteId, editCount: 0, revisionId }),
      });
    }
    sendJobNotification(tx, ctx, job, "revision_requested", [job.editorId], `Revision #${revisionNumber} requested on ${job.jobNumber}`, revEvent, `revision-${revisionNumber}`);
    emitAutomationEvent(tx, ctx, { eventId: revEvent, eventType: "revision.requested", jobId: job.id });
  }

  if (sideEffects) {
    const released = releasedInactiveEditorId ? { releasedInactiveEditorId, releaseReason: "editor_deactivated" } : {};
    if (isRestore) {
      const evt = milestone("job.restored", "restored", { reason, ...released }, { cancelledAt: before.cancelledAt }, { statusId: target.id, category: target.category });
      sendJobNotification(tx, ctx, job, "job_reopened", [job.editorId, job.photographerId], `${job.jobNumber} was restored`, evt);
    } else if (isReopen) {
      const evt = milestone("job.reopened", "reopened", { reason, ...released }, { completedAt: before.completedAt }, { statusId: target.id, category: target.category });
      const extra = ctx.role === "photographer" ? managersOf(tx, ctx.organisationId) : [];
      sendJobNotification(tx, ctx, job, "job_reopened", [job.editorId, job.photographerId, ...extra], `${job.jobNumber} was reopened`, evt);
    }
    if (declined) {
      const evt = milestone("job.declined", "declined", { reason, previousEditorId: before.editorId });
      sendJobNotification(tx, ctx, job, "job_declined", [job.photographerId, ...managersOf(tx, ctx.organisationId)], `${job.jobNumber} was declined by the editor`, evt);
    }
    switch (target.category) {
      case "accepted":
        milestone("job.accepted", "accepted", onBehalfOf ? { onBehalfOf } : {});
        break;
      case "in_progress":
        if (firstStart) milestone("job.work_started", "started", onBehalfOf ? { onBehalfOf } : {});
        break;
      case "submitted": {
        const evt = milestone("job.submitted", "submitted", { resubmission: false, ...(onBehalfOf ? { onBehalfOf } : {}) });
        sendJobNotification(tx, ctx, job, "work_submitted", photographerAndCreator, `${job.jobNumber} was submitted for review`, evt);
        if (currentLinkIds(tx, job.id, ["finished_files", "editing_workspace"]).length === 0) {
          warnings.push("No finished-files or editing-workspace link is attached yet");
        }
        break;
      }
      case "resubmitted": {
        const evt = milestone("job.submitted", "submitted", {
          resubmission: true,
          revisionNumber: resolved?.revisionNumber ?? null,
          ...(onBehalfOf ? { onBehalfOf } : {}),
        });
        sendJobNotification(
          tx,
          ctx,
          job,
          "work_resubmitted",
          [resolved?.requestedByUserId, ...photographerAndCreator],
          `${job.jobNumber} was resubmitted`,
          evt,
        );
        if (currentLinkIds(tx, job.id, ["finished_files", "editing_workspace"]).length === 0) {
          warnings.push("No finished-files or editing-workspace link is attached yet");
        }
        break;
      }
      case "review":
        milestone("job.review_started", "started", { reviewerUserId: ctx.userId });
        break;
      case "approved": {
        const evt = milestone("job.approved", "approved", {
          onTime: job.wasOnTime,
          dueDateAtApproval: job.dueDateAtApproval,
          revisionCount: job.revisionCount,
        });
        sendJobNotification(tx, ctx, job, "work_approved", [job.editorId], `${job.jobNumber} was approved`, evt);
        break;
      }
      case "delivered": {
        const deliveryLinkIds = currentLinkIds(tx, job.id, ["client_delivery", "gallery"]);
        milestone("job.delivered", "delivered", { deliveryLinkIds });
        if (deliveryLinkIds.length === 0) warnings.push("No client-delivery or gallery link is attached yet");
        break;
      }
      case "completed": {
        const evt = milestone("job.completed", "completed");
        sendJobNotification(tx, ctx, job, "job_completed", [job.photographerId, job.editorId], `${job.jobNumber} was completed`, evt);
        break;
      }
      case "cancelled": {
        const evt = milestone("job.cancelled", "cancelled", { reason });
        sendJobNotification(tx, ctx, job, "job_cancelled", [job.editorId, job.photographerId], `${job.jobNumber} was cancelled`, evt);
        break;
      }
      default:
        break;
    }
  }

  // ---- optional timer ----
  if (
    opts.startTimer &&
    ctx.userId &&
    ctx.settings.timeTrackingEnabled &&
    isEditorWorking(target.category) &&
    can(ctx, "timer.use", jobPermissionRef(job))
  ) {
    startTimer(tx, ctx, { jobId: job.id, switchFromRunning: true });
  }

  return {
    job,
    transitionId,
    eventId: statusEventId,
    fromStatus: statusRef(current),
    toStatus: statusRef(target),
    isOverride,
    isReopen,
    isRestore,
    isLateral: lateral,
    revisionId: revisionId ?? resolved?.revisionId ?? null,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/*  Public service functions                                           */
/* ------------------------------------------------------------------ */

/** §4.3 — the only public writer of `jobs.status_id`. */
export function transitionJobStatus(tx: Tx, ctx: AuthContext, input: unknown): TransitionResult {
  const p = parseInput(TransitionInput, input);
  const { job } = loadVisibleJob(tx, ctx, p.jobId);
  const graph = loadWorkflowGraph(tx, ctx.organisationId, job.workflowId);
  const target = resolveTransitionTarget(tx, ctx, job, graph, p);
  assertVersion(job, p.expectedVersion);
  return applyMove(tx, ctx, job, target, graph, {
    mode: "user",
    reason: p.reason,
    override: p.override,
    revision: p.revision ?? null,
    startTimer: p.startTimer,
    cause: ctx.isSystem ? p.cause : undefined,
  });
}

/**
 * Status move without `expectedVersion` (bulk operations and automations:
 * the job is freshly loaded inside the per-job transaction).
 */
export function transitionLoadedJob(
  tx: Tx,
  ctx: AuthContext,
  jobId: string,
  target: { toStatusId?: string | null; toCategory?: StatusCategory | null },
  opts: Omit<ApplyMoveOptions, "mode"> = {},
): TransitionResult {
  const { job } = loadVisibleJob(tx, ctx, jobId);
  const graph = loadWorkflowGraph(tx, ctx.organisationId, job.workflowId);
  const status = resolveTransitionTarget(tx, ctx, job, graph, target);
  return applyMove(tx, ctx, job, status, graph, { ...opts, mode: "user" });
}

export interface AllowedTransitionsResult {
  transitions: JobAvailableActions["transitions"];
  /** Kanban columns the actor may drop the card into. */
  allowedColumns: KanbanColumn[];
}

/** `GET /api/jobs/:id/transitions` — the actor's allowed moves (buttons + kanban). */
export function getAllowedTransitions(db: DbLike, ctx: AuthContext, jobId: string): AllowedTransitionsResult {
  const { job, ref } = loadVisibleJob(db, ctx, jobId);
  const graph = loadWorkflowGraph(db, ctx.organisationId, job.workflowId);
  const wjob = toWorkflowJob(db, job, ref);
  if (ctx.isSystem) {
    return {
      transitions: systemMoves(ctx, wjob, graph).map((m) => ({
        toStatus: statusRef(statusIn(graph, m.toStatus.id)),
        label: m.label,
        isReopen: m.isReopen,
        requiresRevisionPayload: m.requiresRevisionPayload,
        requiresReason: m.requiresReason,
      })),
      allowedColumns: [],
    };
  }
  return {
    transitions: allowedMoves(ctx, wjob, graph.statuses, graph.edges).map((m) => ({
      toStatus: statusRef(statusIn(graph, m.toStatus.id)),
      label: m.label,
      isReopen: m.isReopen,
      requiresRevisionPayload: m.requiresRevisionPayload,
      requiresReason: m.requiresReason,
    })),
    allowedColumns: allowedKanbanColumns(ctx, wjob, graph.statuses, graph.edges),
  };
}

/** Full `JobAvailableActions` for the job detail header. */
export function getAvailableActions(db: DbLike, ctx: AuthContext, jobId: string): JobAvailableActions {
  const { job, ref } = loadVisibleJob(db, ctx, jobId);
  const graph = loadWorkflowGraph(db, ctx.organisationId, job.workflowId);
  const running = ctx.userId
    ? db
        .select({ id: workSessions.id })
        .from(workSessions)
        .where(and(eq(workSessions.jobId, job.id), eq(workSessions.userId, ctx.userId), isNull(workSessions.endedAt)))
        .get()
    : undefined;
  const actions = availableActions(ctx, toWorkflowJob(db, job, ref), graph.statuses, graph.edges, {
    timeTrackingEnabled: ctx.settings.timeTrackingEnabled,
    openRevision: job.openRevisionId !== null,
    hasRunningSession: running !== undefined,
  });
  // Lib refs carry the lib's colour fallback; use the stored status rows.
  return { ...actions, transitions: actions.transitions.map((t) => ({ ...t, toStatus: statusRef(statusIn(graph, t.toStatus.id)) })) };
}

/** Restore a cancelled job to the status it was cancelled from (initial status if archived). */
export function restoreJob(tx: Tx, ctx: AuthContext, input: unknown): TransitionResult {
  const p = parseInput(RestoreInput, input);
  const { job } = loadVisibleJob(tx, ctx, p.jobId);
  assertVersion(job, p.expectedVersion);
  const graph = loadWorkflowGraph(tx, ctx.organisationId, job.workflowId);
  const current = statusIn(graph, job.statusId);
  if (current.category !== "cancelled") throw new InvalidTransitionError(current.name, "restore", "Only cancelled jobs can be restored");
  const target = restoreTargetOf(graph.statuses, job.previousStatusId);
  if (!target) throw new NotFoundError("Status", "This workflow has no status to restore to");
  return applyMove(tx, ctx, job, statusIn(graph, target.id), graph, { mode: "restore", reason: p.reason });
}

export interface MigrateWorkflowResult {
  job: Job;
  transitionId: string;
  eventId: string;
}

/** Moves one job to another workflow (`kind='migration'` transition, `job.workflow_migrated`). */
export function migrateWorkflow(tx: Tx, ctx: AuthContext, input: unknown): MigrateWorkflowResult {
  const p = parseInput(MigrateWorkflowInput, input);
  const { job: loaded, ref } = loadVisibleJob(tx, ctx, p.jobId);
  assertCan(ctx, "job.migrate_workflow", ref);
  assertVersion(loaded, p.expectedVersion);
  const workflow = loadWorkflowInOrg(tx, ctx, p.workflowId);
  if (workflow.archivedAt !== null) throw new ValidationError("That workflow is archived");
  if (workflow.id === loaded.workflowId) throw new ValidationError("The job already uses that workflow");
  const toStatus = loadStatusInWorkflow(tx, ctx, workflow.id, p.toStatusId);
  if (toStatus.archivedAt !== null) throw new NotFoundError("Status");
  if (EDITOR_REQUIRED_CATEGORIES.includes(toStatus.category) && !isUserActive(tx, loaded.editorId)) throw new EditorRequiredError();
  const fromGraph = loadWorkflowGraph(tx, ctx.organisationId, loaded.workflowId);
  const fromStatus = statusIn(fromGraph, loaded.statusId);
  const fromWorkflow = loadWorkflowInOrg(tx, ctx, loaded.workflowId);

  closeRunningSessions(tx, ctx, { jobId: loaded.id }, "auto_status_change", "status_change");
  const now = ctx.now();
  const open = loadOpenTransition(tx, loaded.id);
  const duration = durationSeconds(open.enteredAt, now, now);
  tx.update(jobStatusTransitions)
    .set({ exitedAt: now, durationSeconds: duration })
    .where(and(eq(jobStatusTransitions.id, open.id), isNull(jobStatusTransitions.exitedAt)))
    .run();
  const transitionId = newId();
  tx.insert(jobStatusTransitions)
    .values({
      id: transitionId,
      organisationId: ctx.organisationId,
      jobId: loaded.id,
      sequence: nextSequence(tx, loaded.id),
      kind: "migration",
      fromStatusId: fromStatus.id,
      toStatusId: toStatus.id,
      fromCategory: fromStatus.category,
      toCategory: toStatus.category,
      statusName: toStatus.name,
      actorUserId: ctx.userId,
      automationRunId: ctx.automationRunId ?? null,
      reason: p.reason ?? null,
      enteredAt: now,
      editorIdAtEntry: loaded.editorId,
      photographerIdAtEntry: loaded.photographerId,
    })
    .run();
  const job = updateJobRow(tx, ctx, loaded, {
    workflowId: workflow.id,
    statusId: toStatus.id,
    statusCategory: toStatus.category,
    previousStatusId: fromStatus.id,
    statusEnteredAt: now,
    isPaused: false,
    pausedAt: null,
    completedAt: toStatus.category === "completed" ? now : null,
    cancelledAt: toStatus.category === "cancelled" ? now : null,
  });
  const eventId = recordEvent(tx, ctx, {
    entityType: "job",
    entityId: job.id,
    jobId: job.id,
    eventType: "job.workflow_migrated",
    action: "migrated",
    previousValue: { workflowId: fromWorkflow.id, statusId: fromStatus.id, statusName: fromStatus.name, workflowName: fromWorkflow.name },
    newValue: { workflowId: workflow.id, statusId: toStatus.id, statusName: toStatus.name, workflowName: workflow.name },
    metadata: jobEventMeta(job, {
      transitionId,
      reason: p.reason ?? null,
      fromWorkflowName: fromWorkflow.name,
      toWorkflowName: workflow.name,
      durationInPreviousSeconds: duration,
    }),
  });
  tx.update(jobStatusTransitions).set({ activityEventId: eventId }).where(eq(jobStatusTransitions.id, transitionId)).run();
  return { job, transitionId, eventId };
}

/* ------------------------------------------------------------------ */
/*  Convenience wrappers (POST /api/jobs/:id/accept|decline|…)         */
/* ------------------------------------------------------------------ */

function moveToCategory(
  tx: Tx,
  ctx: AuthContext,
  p: { jobId: string; expectedVersion: number; toStatusId?: string; reason?: string | null; startTimer?: boolean },
  category: StatusCategory,
  extra: { revision?: RevisionInputValue | null } = {},
): TransitionResult {
  const { job } = loadVisibleJob(tx, ctx, p.jobId);
  const graph = loadWorkflowGraph(tx, ctx.organisationId, job.workflowId);
  const target = resolveTransitionTarget(tx, ctx, job, graph, p.toStatusId ? { toStatusId: p.toStatusId } : { toCategory: category });
  if (target.category !== category) {
    throw new ValidationError(`That status is not a "${category}" status`, { formErrors: [], fieldErrors: { toStatusId: ["Wrong category"] } });
  }
  assertVersion(job, p.expectedVersion);
  return applyMove(tx, ctx, job, target, graph, {
    mode: "user",
    reason: p.reason,
    startTimer: p.startTimer,
    revision: extra.revision ?? null,
  });
}

const categoryWrapper =
  (category: StatusCategory) =>
  (tx: Tx, ctx: AuthContext, input: unknown): TransitionResult =>
    moveToCategory(tx, ctx, parseInput(CategoryMoveInput, input), category);

/** Editor accepts an assigned job (assigned → accepted). */
export const acceptJob = categoryWrapper("accepted");
/** Editor declines an assigned job (assigned → ready; editor removed, `previous_editor_id` kept). */
export const declineJob = categoryWrapper("ready");
/** → in_progress (optionally `startTimer`). */
export const startJob = categoryWrapper("in_progress");
/** in_progress → submitted. */
export const submitJob = categoryWrapper("submitted");
/** submitted / resubmitted → review. */
export const beginReview = categoryWrapper("review");
/** → approved (snapshots due_date_at_approval / was_on_time). */
export const approveJob = categoryWrapper("approved");
/** approved → delivered. */
export const deliverJob = categoryWrapper("delivered");
/** approved / delivered → completed. */
export const completeJob = categoryWrapper("completed");

/** Any active status → cancelled (reason required). */
export function cancelJob(tx: Tx, ctx: AuthContext, input: unknown): TransitionResult {
  return moveToCategory(tx, ctx, parseInput(CancelInput, input), "cancelled");
}

/** completed → in_progress (default) | revision (payload required) | approved; reason required. */
export function reopenJob(tx: Tx, ctx: AuthContext, input: unknown): TransitionResult {
  const p = parseInput(ReopenInput, input);
  return moveToCategory(tx, ctx, p, p.toCategory ?? "in_progress", { revision: p.revision ?? null });
}

/* ------------------------------------------------------------------ */
/*  Bulk runner (one transaction per job, §4.5)                        */
/* ------------------------------------------------------------------ */

/** Maps a thrown error to a `BulkResult.failed` entry. */
export function bulkFailure(id: string, err: unknown): BulkResult["failed"][number] {
  if (err instanceof AppError) return { id, code: err.code, message: err.message };
  return { id, code: "internal", message: "Unexpected error" };
}

/**
 * Runs `fn` for every (distinct) job id in its own transaction; failures are
 * collected, never thrown. Every event written carries `metadata.batchId`
 * (the callback receives it). With `organisationId`, the org's pending
 * automation runs execute once after all per-job transactions committed (§7).
 */
export function runPerJob(
  jobIds: readonly string[],
  fn: (tx: Tx, jobId: string, batchId: string) => void,
  options: { db?: Db; batchId?: string; organisationId?: string } = {},
): BulkResult {
  const batchId = options.batchId ?? shortId();
  const ok: string[] = [];
  const failed: BulkResult["failed"] = [];
  for (const jobId of Array.from(new Set(jobIds))) {
    try {
      withTx((tx) => fn(tx, jobId, batchId), { db: options.db });
      ok.push(jobId);
    } catch (err) {
      failed.push(bulkFailure(jobId, err));
    }
  }
  if (options.organisationId && ok.length > 0) runAutomationsAfterCommit(options.db ?? getDb(), options.organisationId);
  return { ok, failed, batchId };
}
