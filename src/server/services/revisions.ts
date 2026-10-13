/**
 * Revisions service (ARCHITECTURE.md §2.4 job_revisions, §4.4, §9 Revisions).
 *
 * - `requestRevision`  = transition → revision with the payload (numbering via
 *   MAX(revision_number) + 1 inside the engine: never reused, withdrawn ones count)
 * - `updateRevision`   = assignee / instructions / priority / due date while open
 *   (`revision.updated`, the only in-place edits the job_revisions trigger allows)
 * - `resolveRevision`  = transition → resubmitted (resolution "resubmitted")
 * - `withdrawRevision` = back to the status the revision was requested from
 *   (from_status_id of its request transition), resolution "withdrawn"
 *
 * Every function is async (Postgres); callers await them inside one `withTx`.
 */
import { and, eq, isNull } from "drizzle-orm";
import { first, type Tx } from "@/db/index";
import { jobRevisions, jobStatusTransitions } from "@/db/schema";
import type { AuthContext, JobRevision } from "@/lib/types";
import { optionalDeadlineToIso } from "@/lib/validation/jobs";
import { RequestRevisionInput, ResolveRevisionInput, UpdateRevisionInput, WithdrawRevisionInput } from "@/lib/validation/revisions";
import { assertCan, can } from "@/server/auth/permissions";
import { recordEvent } from "@/server/audit";
import { ForbiddenError, InvalidTransitionError, NotFoundError, ValidationError } from "@/server/errors";
import { assertVersion, loadRevisionInOrg, loadUserInOrg, parseInput } from "./_shared";
import { assignEditorToJob } from "./assignments";
import { notify } from "./notifications";
import {
  applyMove,
  assertMayMoveJob,
  isPastEditorOf,
  jobEventMeta,
  jobLinkPath,
  loadVisibleJob,
  loadWorkflowGraph,
  movedOnMessage,
  resolveTransitionTarget,
  type TransitionResult,
} from "./workflow";

export interface RevisionTransitionResult extends TransitionResult {
  revision: JobRevision;
}

async function loadRevision(tx: Tx, id: string): Promise<JobRevision> {
  const row = await first(tx.select().from(jobRevisions).where(eq(jobRevisions.id, id)));
  if (!row) throw new NotFoundError("Revision");
  return row;
}

/** `POST /api/jobs/:id/revisions` — request revision #n (job moves to a revision status). */
export async function requestRevision(tx: Tx, ctx: AuthContext, input: unknown): Promise<RevisionTransitionResult> {
  const p = parseInput(RequestRevisionInput, input);
  const { job, ref } = await loadVisibleJob(tx, ctx, p.jobId);
  assertMayMoveJob(ctx, ref);
  const graph = await loadWorkflowGraph(tx, ctx.organisationId, job.workflowId);
  const target = await resolveTransitionTarget(tx, ctx, job, graph, p.toStatusId ? { toStatusId: p.toStatusId } : { toCategory: "revision" });
  if (target.category !== "revision") {
    throw new ValidationError("That status is not a revision status", { formErrors: [], fieldErrors: { toStatusId: ["Wrong category"] } });
  }
  assertVersion(job, p.expectedVersion);
  const { jobId: _jobId, expectedVersion: _version, toStatusId: _toStatusId, ...payload } = p;
  void _jobId;
  void _version;
  void _toStatusId;
  const result = await applyMove(tx, ctx, job, target, graph, { mode: "user", revision: payload, reason: payload.reason });
  if (!result.revisionId) throw new ValidationError("No revision was created");
  return { ...result, revision: await loadRevision(tx, result.revisionId) };
}

export interface UpdateRevisionResult {
  revision: JobRevision;
  changed: string[];
}

/**
 * `PATCH /api/revisions/:id` — while open only; audited `revision.updated` with the changed fields.
 *
 * The open revision's assignee IS the job's editor (§4.4, db:verify
 * `open_revision_assignee_is_editor`): naming another editor reassigns the
 * job through `assignEditorToJob` in the same transaction (permission
 * `job.assign_editor`, like the revision-request path), which re-attributes
 * the stage, re-points this revision and sends the new editor the mandatory
 * `revision_requested` notice. Nobody is ever told about a job they cannot open.
 */
export async function updateRevision(tx: Tx, ctx: AuthContext, input: unknown): Promise<UpdateRevisionResult> {
  const p = parseInput(UpdateRevisionInput, input);
  let revision = await loadRevisionInOrg(tx, ctx, p.revisionId);
  const { job, ref } = await loadVisibleJob(tx, ctx, revision.jobId);
  assertCan(ctx, "revision.request", ref);
  if (revision.resolvedAt !== null) throw new ValidationError("This revision is closed and can no longer be edited");

  const patch: Partial<Pick<JobRevision, "assigneeUserId" | "instructions" | "priority" | "dueDate">> = {};
  const prev: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  const changed: string[] = [];
  if (p.assigneeUserId !== undefined && p.assigneeUserId !== revision.assigneeUserId) {
    if (p.assigneeUserId) {
      const user = await loadUserInOrg(tx, ctx, p.assigneeUserId);
      if (!user.isActive) throw new ValidationError(`${user.name} is deactivated`);
      if (user.role !== "editor") throw new ValidationError(`${user.name} is not an editor`);
    }
    if (p.assigneeUserId && p.assigneeUserId !== job.editorId) {
      // Hand the JOB over (stage re-attribution + revision re-point + notices).
      assertCan(ctx, "job.assign_editor", ref);
      await assignEditorToJob(tx, ctx, job, p.assigneeUserId, { reason: "Revision assignee changed" });
      revision = await loadRevision(tx, revision.id);
      changed.push("assigneeUserId");
    } else {
      patch.assigneeUserId = p.assigneeUserId;
    }
  }
  if (p.instructions !== undefined) {
    const value = p.instructions === "" ? null : p.instructions;
    if (value !== revision.instructions) patch.instructions = value;
  }
  if (p.priority !== undefined && p.priority !== revision.priority) patch.priority = p.priority;
  if (p.dueDate !== undefined) {
    const value = optionalDeadlineToIso(p.dueDate, ctx.settings.timezone) ?? null;
    if (value !== revision.dueDate) patch.dueDate = value;
  }
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length === 0) return { revision, changed };
  for (const k of keys) {
    prev[k] = revision[k];
    next[k] = patch[k];
  }

  const updated = await first(
    tx
      .update(jobRevisions)
      .set(patch)
      .where(and(eq(jobRevisions.id, revision.id), isNull(jobRevisions.resolvedAt)))
      .returning(),
  );
  if (!updated) throw new ValidationError("This revision is closed and can no longer be edited");
  const eventId = await recordEvent(tx, ctx, {
    entityType: "revision",
    entityId: revision.id,
    jobId: job.id,
    eventType: "revision.updated",
    action: "updated",
    previousValue: prev,
    newValue: next,
    metadata: jobEventMeta(job, { revisionId: revision.id, revisionNumber: revision.revisionNumber }),
  });
  if (patch.assigneeUserId) {
    await notify(tx, ctx, {
      userIds: [patch.assigneeUserId],
      type: "revision_requested",
      title: `Changes asked on ${job.jobNumber} (round ${revision.revisionNumber}) are now yours`,
      body: revision.reason,
      jobId: job.id,
      activityEventId: eventId,
      linkPath: jobLinkPath(job.id, `revision-${revision.revisionNumber}`),
    });
  }
  return { revision: updated, changed: [...changed, ...keys] };
}

/** `POST /api/revisions/:id/resolve` — the editor resubmits (revision → resubmitted). */
export async function resolveRevision(tx: Tx, ctx: AuthContext, input: unknown): Promise<RevisionTransitionResult> {
  const p = parseInput(ResolveRevisionInput, input);
  const revision = await loadRevisionInOrg(tx, ctx, p.revisionId);
  const { job, ref } = await loadVisibleJob(tx, ctx, revision.jobId);
  // Permission before state and version (a read-only viewer gets 403, never a 409 carrying the row) —
  // except a PAST editor on a stale page, who gets the 409 so their screen refreshes (see assertMayMoveJobOrStale).
  if (!can(ctx, "revision.resolve", ref)) {
    if (isPastEditorOf(ctx, job, ref)) {
      assertVersion(job, p.expectedVersion);
      throw new ForbiddenError("revision.resolve", await movedOnMessage(tx, ctx, job));
    }
    throw new ForbiddenError("revision.resolve", "Only the assigned editor can do this");
  }
  if (revision.resolvedAt !== null) throw new ValidationError("This revision is already resolved");
  if (job.statusCategory !== "revision") {
    throw new InvalidTransitionError(job.statusCategory, "resubmitted", "The job is not waiting on this revision");
  }
  const graph = await loadWorkflowGraph(tx, ctx.organisationId, job.workflowId);
  const target = await resolveTransitionTarget(tx, ctx, job, graph, p.toStatusId ? { toStatusId: p.toStatusId } : { toCategory: "resubmitted" });
  if (target.category !== "resubmitted") {
    throw new ValidationError("That status is not a resubmitted status", { formErrors: [], fieldErrors: { toStatusId: ["Wrong category"] } });
  }
  assertVersion(job, p.expectedVersion);
  const result = await applyMove(tx, ctx, job, target, graph, { mode: "user", resolutionNote: p.note ?? null });
  return { ...result, revision: await loadRevision(tx, revision.id) };
}

/**
 * `POST /api/revisions/:id/withdraw` — the requester takes the revision back:
 * the job returns to the status it was in when the revision was requested
 * (same category's lowest status if that one is archived) and the revision is
 * resolved "withdrawn". Its number is never reused.
 */
export async function withdrawRevision(
  tx: Tx,
  ctx: AuthContext,
  input: unknown,
): Promise<RevisionTransitionResult | { revision: JobRevision; transitionId: null }> {
  const p = parseInput(WithdrawRevisionInput, input);
  const revision = await loadRevisionInOrg(tx, ctx, p.revisionId);
  const { job, ref } = await loadVisibleJob(tx, ctx, revision.jobId);
  assertCan(ctx, "revision.withdraw", ref);
  if (revision.resolvedAt !== null) throw new ValidationError("This revision is already resolved");
  assertVersion(job, p.expectedVersion);
  const graph = await loadWorkflowGraph(tx, ctx.organisationId, job.workflowId);

  if (job.statusCategory !== "revision") {
    // The job already left the revision stage (e.g. an override): resolve the row only.
    const now = ctx.now();
    await tx.update(jobRevisions)
      .set({ resolvedAt: now, resolvedByUserId: ctx.userId, resolution: "withdrawn", resolutionNote: p.note ?? null })
      .where(and(eq(jobRevisions.id, revision.id), isNull(jobRevisions.resolvedAt)));
    await recordEvent(tx, ctx, {
      entityType: "revision",
      entityId: revision.id,
      jobId: job.id,
      eventType: "revision.withdrawn",
      action: "withdrawn",
      previousValue: { resolvedAt: null },
      newValue: { resolvedAt: now, resolvedByUserId: ctx.userId, resolution: "withdrawn", resolutionNote: p.note ?? null },
      metadata: jobEventMeta(job, { revisionId: revision.id, revisionNumber: revision.revisionNumber, transitionId: null }),
    });
    return { revision: await loadRevision(tx, revision.id), transitionId: null };
  }

  const request = revision.requestTransitionId
    ? await first(tx.select().from(jobStatusTransitions).where(eq(jobStatusTransitions.id, revision.requestTransitionId)))
    : undefined;
  const fromId = request?.fromStatusId ?? job.previousStatusId;
  const fromCategory = request?.fromCategory ?? null;
  let target = graph.statuses.find((s) => s.id === fromId && s.archivedAt === null);
  if (!target && fromCategory) {
    target = graph.statuses
      .filter((s) => s.archivedAt === null && s.category === fromCategory)
      .sort((a, b) => a.sortOrder - b.sortOrder)[0];
  }
  if (!target || target.category === "revision") {
    throw new InvalidTransitionError(job.statusCategory, "withdraw", "Cannot work out the status to return to; use a status change instead");
  }
  const result = await applyMove(tx, ctx, job, target, graph, { mode: "withdraw", resolutionNote: p.note ?? null, reason: p.note ?? "Revision withdrawn" });
  return { ...result, revision: await loadRevision(tx, revision.id) };
}
