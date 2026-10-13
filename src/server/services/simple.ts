/**
 * Simplified job actions (docs/SIMPLIFICATION-PLAN.md §4, §5, §8, §9, §12) — the one-button steps of
 * the five-stage UI, built ON TOP of the existing engine. Nothing here writes `jobs.status_id`, an
 * assignment, a link or a notification directly: every step goes through `transitionJobStatus`'s
 * engine (`applyMove`), `assignEditor` / `unassignEditor`, `requestRevision`, `addLink` /
 * `replaceLink`, `shareLink` and `notify`, so every underlying status is still its own permanent
 * history entry ("Approve & send" = Approved → Delivered → Completed, three rows in one go).
 *
 * Rules (plan §9):
 *  - the stages are a DISPLAY layer: no job row is rewritten, nothing is bulk-updated;
 *  - when a workflow has two statuses that mean the same stage, the first (lowest sortOrder) the actor
 *    may move to is picked instead of asking;
 *  - if a studio's custom workflow lacks a step, the action stops at the furthest step it can reach and
 *    NEVER adds steps to anyone's workflow;
 *  - "Send for checking" REQUIRES a finished link (stricter than today's warning);
 *  - owners / co-owners may approve a job they edited themselves after `confirmSelfApproval`
 *    (decision 3; the engine records `selfApproved`); editors and non-admin photographers stay blocked.
 *
 * Every function is async (Postgres); callers run them inside one `withTx`.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { first, one, type DbLike, type Tx } from "@/db/index";
import { clients, jobs, notifications, users } from "@/db/schema";
import {
  DEFAULT_OFF_NOTIFICATION_TYPES,
  SIMPLE_CHANGES_DEFAULT_DAYS,
  SIMPLE_CHANGES_DEFAULT_REASON,
  SIMPLE_LINK_SLOTS,
  SIMPLE_REOPEN_REASON_LABELS,
  type ApproveShareChoice,
  type StatusCategory,
} from "@/lib/constants";
import { addCivilDays, todayCivil } from "@/lib/dates";
import { describeStage, stageOf, type Stage, type StageDisplay } from "@/lib/stages";
import type { AuthContext, Job, JobLink, JobPermissionRef, JobRevision, JobType, OrganisationSettings, WorkflowStatus } from "@/lib/types";
import {
  ApproveJobInput,
  AskForChangesInput,
  AssignEditorSimpleInput,
  CancelJobSimpleInput,
  ChangeEditorInput,
  CloseDeliveredJobsInput,
  DeclineJobSimpleInput,
  ReopenJobSimpleInput,
  RestoreJobSimpleInput,
  SendForCheckingInput,
  SetAdvancedToolsInput,
  SetEditorUsualCapacityInput,
  SetJobTypeUsualDaysInput,
  TakeBackFromEditorInput,
} from "@/lib/validation/simple";
import { assertCan, can, selfReviewBlocked, selfReviewNeedsConfirm } from "@/server/auth/permissions";
import { recordEvent } from "@/server/audit";
import { AppError, ForbiddenError, InvalidTransitionError, NotFoundError, RuleViolationError, UnauthorizedError, ValidationError } from "@/server/errors";
import { UserRuleError, checkVersion } from "./_admin";
import { assertVersion, loadUserInOrg, parseInput, safeUser, withSavepoint, type SafeUser } from "./_shared";
import { assignEditor, unassignEditor, type AssignEditorResult } from "./assignments";
import { updateJobType } from "./jobTypes";
import { addLink, currentLinksOfKinds, replaceLink } from "./links";
import { requestRevision } from "./revisions";
import { updateSettings } from "./settings";
import { isClientVisible, shareLink } from "./sharing";
import { userPermissionRef } from "./users";
import {
  applyMove,
  assertMayMoveJob,
  bulkFailure,
  cancelJob,
  declineJob,
  freshJobRef,
  loadVisibleJob,
  loadWorkflowGraph,
  movesFor,
  restoreJob,
  toWorkflowJob,
  transitionLoadedJob,
  type ApplyMoveOptions,
  type TransitionResult,
  type WorkflowGraph,
} from "./workflow";

/* ------------------------------------------------------------------ */
/*  Shared                                                             */
/* ------------------------------------------------------------------ */

/** The stage pill data of a job row (plan §4). */
export function jobStage(job: Pick<Job, "statusCategory" | "revisionCount" | "startedAt" | "statusEnteredAt">): StageDisplay {
  return describeStage({ category: job.statusCategory, revisionCount: job.revisionCount, startedAt: job.startedAt, statusEnteredAt: job.statusEnteredAt });
}

export interface SimpleJobResult {
  job: Job;
  stage: StageDisplay;
}

function requireStage(job: Job, allowed: readonly Stage[], action: string): Stage {
  const stage = stageOf(job.statusCategory);
  if (!allowed.includes(stage)) {
    throw new InvalidTransitionError(job.statusCategory, action, `"${action}" is not available while the job is in ${describeStage({ category: job.statusCategory, revisionCount: job.revisionCount }).label}`);
  }
  return stage;
}

/**
 * The status this actor may move the job to inside `category` right now: the explicit, non-lateral
 * moves the engine offers, lowest sortOrder first (plan §10 phase 2: the first of two same-stage
 * statuses is picked automatically). Null = this workflow has no reachable step there.
 */
async function nextTarget(tx: Tx, ctx: AuthContext, job: Job, graph: WorkflowGraph, category: StatusCategory): Promise<WorkflowStatus | null> {
  const ref = await freshJobRef(tx, ctx, job);
  const wjob = await toWorkflowJob(tx, job, ref);
  const moves = movesFor(ctx, wjob, graph)
    .filter((m) => m.toStatus.category === category && !m.isLateral && !m.isRestore)
    .sort((a, b) => a.toStatus.sortOrder - b.toStatus.sortOrder);
  const pick = moves[0]?.toStatus;
  return pick ? (graph.statuses.find((s) => s.id === pick.id) ?? null) : null;
}

/** One recorded engine move into `category`; null when the workflow has no reachable step (the caller stops there). */
async function moveInto(
  tx: Tx,
  ctx: AuthContext,
  job: Job,
  graph: WorkflowGraph,
  category: StatusCategory,
  opts: Omit<ApplyMoveOptions, "mode">,
): Promise<TransitionResult | null> {
  const target = await nextTarget(tx, ctx, job, graph, category);
  if (!target) return null;
  return applyMove(tx, ctx, job, target, graph, { ...opts, mode: "user" });
}

/* ------------------------------------------------------------------ */
/*  Assign / change / take back / decline                              */
/* ------------------------------------------------------------------ */

export interface AssignEditorSimpleResult extends SimpleJobResult {
  assignment: AssignEditorResult;
}

/** Assign editor (plan §4 stage 1 → 2): the engine moves New / Ready straight to Assigned, skipping "Ready". */
export async function assignEditorSimple(tx: Tx, ctx: AuthContext, input: unknown): Promise<AssignEditorSimpleResult> {
  const p = parseInput(AssignEditorSimpleInput, input);
  const { job, ref } = await loadVisibleJob(tx, ctx, p.jobId);
  assertCan(ctx, "job.assign_editor", ref);
  requireStage(job, ["needs_editor", "with_editor", "changes_asked"], "Assign editor");
  const assignment = await assignEditor(tx, ctx, { jobId: job.id, userId: p.editorId, expectedVersion: p.expectedVersion, reason: "Assigned" });
  return { job: assignment.job, stage: jobStage(assignment.job), assignment };
}

/** Change editor (plan §5): reassign; the open stage is re-attributed to the new editor by the engine. */
export async function changeEditor(tx: Tx, ctx: AuthContext, input: unknown): Promise<AssignEditorSimpleResult> {
  const p = parseInput(ChangeEditorInput, input);
  const { job, ref } = await loadVisibleJob(tx, ctx, p.jobId);
  assertCan(ctx, "job.assign_editor", ref);
  requireStage(job, ["needs_editor", "with_editor", "ready_to_check", "changes_asked"], "Change editor");
  const assignment = await assignEditor(tx, ctx, { jobId: job.id, userId: p.editorId, expectedVersion: p.expectedVersion, reason: p.reason ?? "Changed editor" });
  return { job: assignment.job, stage: jobStage(assignment.job), assignment };
}

/** Take back from editor (plan §5 ⋯): the editor is removed and the job returns to Needs editor. */
export async function takeBackFromEditor(tx: Tx, ctx: AuthContext, input: unknown): Promise<AssignEditorSimpleResult> {
  const p = parseInput(TakeBackFromEditorInput, input);
  const { job, ref } = await loadVisibleJob(tx, ctx, p.jobId);
  assertCan(ctx, "job.assign_editor", ref);
  requireStage(job, ["with_editor", "changes_asked"], "Take back from editor");
  if (!job.editorId) throw new InvalidTransitionError(job.statusCategory, "ready", "This job has no editor to take it back from");
  const assignment = await unassignEditor(tx, ctx, { jobId: job.id, expectedVersion: p.expectedVersion, reason: p.reason ?? "Taken back", unassignReason: "unassigned" });
  return { job: assignment.job, stage: jobStage(assignment.job), assignment };
}

export interface DeclineJobSimpleResult extends SimpleJobResult {
  transition: TransitionResult;
}

/**
 * "Can't do this one" (plan §5): the assigned editor hands a not-yet-started job back to Needs editor with
 * a reason (engine edge Assigned → Ready, `job.decline`). Once editing has begun the workflow gives the
 * editor no way back: they ask the photographer to take it back (422 with that message).
 */
export async function declineJobSimple(tx: Tx, ctx: AuthContext, input: unknown): Promise<DeclineJobSimpleResult> {
  const p = parseInput(DeclineJobSimpleInput, input);
  const { job, ref } = await loadVisibleJob(tx, ctx, p.jobId);
  assertMayMoveJob(ctx, ref);
  requireStage(job, ["with_editor", "changes_asked"], "Can't do this one");
  if (!can(ctx, "job.decline", ref)) {
    if (job.statusCategory !== "assigned" && job.editorId === ctx.userId) {
      throw new InvalidTransitionError(job.statusCategory, "ready", "Editing has started: ask the photographer to take the job back");
    }
    throw new ForbiddenError("job.decline", "Only the assigned editor can do this");
  }
  const transition = await declineJob(tx, ctx, { jobId: job.id, expectedVersion: p.expectedVersion, reason: p.reason });
  return { job: transition.job, stage: jobStage(transition.job), transition };
}

/* ------------------------------------------------------------------ */
/*  Send for checking                                                  */
/* ------------------------------------------------------------------ */

export interface SendForCheckingResult extends SimpleJobResult {
  /** The finished link now current on the job. */
  finishedLink: JobLink;
  /** Every recorded step (Start editing when the job had not started, then Submit / Resubmit). */
  transitions: TransitionResult[];
  warnings: string[];
}

function linkPermissionRef(ref: JobPermissionRef, link: JobLink) {
  return { job: ref, kind: link.kind, addedByUserId: link.addedByUserId, isCurrent: true, sharedWithClient: link.sharedWithClient };
}

/**
 * Records the finished link (plan §5 "Files"): a new URL supersedes the current finished link when the
 * actor may replace it (else it is added beside it), the same URL is kept, `reuseCurrent` keeps the
 * current one. 422 when nothing is there to reuse.
 */
async function recordFinishedLink(
  tx: Tx,
  ctx: AuthContext,
  job: Job,
  ref: JobPermissionRef,
  input: { url: string; label?: string | null } | { reuseCurrent: true },
  field: string,
): Promise<JobLink> {
  const current = await currentLinksOfKinds(tx, job.id, SIMPLE_LINK_SLOTS.finished);
  const preferred = current.find((l) => l.kind === "finished_files") ?? current[0];
  if ("reuseCurrent" in input) {
    if (!preferred) throw new RuleViolationError("Add the finished photos link first", { formErrors: [], fieldErrors: { [field]: ["Required"] } });
    return preferred;
  }
  if (preferred && preferred.url === input.url) return preferred;
  if (preferred && can(ctx, "link.replace", linkPermissionRef(ref, preferred))) {
    return (await replaceLink(tx, ctx, { linkId: preferred.id, url: input.url, ...(input.label !== undefined ? { label: input.label } : {}) })).link;
  }
  return addLink(tx, ctx, { jobId: job.id, kind: "finished_files", url: input.url, label: input.label ?? null });
}

/**
 * Send for checking (plan §4 stages 2 / 4 → 3): REQUIRES the finished link, then submits (With editor,
 * starting the editing step first when the job had not started) or resubmits (Changes asked) through
 * the engine, which closes running timers and resolves the open round as today.
 */
export async function sendForChecking(tx: Tx, ctx: AuthContext, input: unknown): Promise<SendForCheckingResult> {
  const p = parseInput(SendForCheckingInput, input);
  const { job: loaded, ref } = await loadVisibleJob(tx, ctx, p.jobId);
  assertMayMoveJob(ctx, ref);
  const stage = requireStage(loaded, ["with_editor", "changes_asked"], "Send for checking");
  assertCan(ctx, stage === "changes_asked" ? "revision.resolve" : "job.submit", ref);
  assertVersion(loaded, p.expectedVersion);

  const finishedLink = await recordFinishedLink(tx, ctx, loaded, ref, p.finishedLink, "finishedLink");
  const graph = await loadWorkflowGraph(tx, ctx.organisationId, loaded.workflowId);
  const transitions: TransitionResult[] = [];
  let job = loaded;
  if (stage === "with_editor" && job.statusCategory !== "in_progress") {
    const started = await moveInto(tx, ctx, job, graph, "in_progress", { startTimer: false });
    if (!started) throw new InvalidTransitionError(job.statusCategory, "in_progress", "This workflow has no editing step the editor can start");
    transitions.push(started);
    job = started.job;
  }
  const target: StatusCategory = stage === "changes_asked" ? "resubmitted" : "submitted";
  const sent = await moveInto(tx, ctx, job, graph, target, { resolutionNote: p.note ?? null });
  if (!sent) throw new InvalidTransitionError(job.statusCategory, target, "This workflow has no way to send the job for checking from here");
  transitions.push(sent);
  job = sent.job;
  return { job, stage: jobStage(job), finishedLink, transitions, warnings: transitions.flatMap((t) => t.warnings) };
}

/* ------------------------------------------------------------------ */
/*  Approve                                                            */
/* ------------------------------------------------------------------ */

export interface ApproveJobResult extends SimpleJobResult {
  /** Every recorded step: Approved, then Delivered and / or Completed as far as the workflow allows. */
  steps: TransitionResult[];
  /** The category the chain stopped at (plan §9: the furthest reachable step, never an added one). */
  stoppedAt: StatusCategory;
  /** The client was NOT sent the work by this action ("Not sent to client" badge + "Send to client" button). */
  notSentToClient: boolean;
  /** The job (and its links) became client-visible through this action. */
  sharedWithClient: boolean;
  /** An owner approved their own edit (decision 3) — also in every event's metadata. */
  selfApproved: boolean;
}

/**
 * Approve (plan §5, decisions 2 + 3). "send": Approved → Delivered (delivery step shares the job and the
 * chosen / default links, tells the portal users) → Completed; "only": Approved, stop; "n/a": Approved →
 * Completed. Each step is its own history row. A workflow without a Delivered status delivers through the
 * completing move (still the delivery step); one without a reachable Completed stops at Approved /
 * Delivered. Editors and non-admin photographers never approve their own edit (403); admins confirm.
 */
export async function approveJob(tx: Tx, ctx: AuthContext, input: unknown): Promise<ApproveJobResult> {
  const p = parseInput(ApproveJobInput, input);
  const { job: loaded, ref } = await loadVisibleJob(tx, ctx, p.jobId);
  assertMayMoveJob(ctx, ref);
  if (selfReviewBlocked(ctx, ref)) throw new ForbiddenError("job.approve", "You can't check your own edit");
  assertCan(ctx, "job.approve", ref);
  requireStage(loaded, ["ready_to_check"], "Approve");
  assertVersion(loaded, p.expectedVersion);
  const selfApproved = selfReviewNeedsConfirm(ctx, ref);
  const confirm = { confirmSelfApproval: p.confirmSelfApproval };

  const graph = await loadWorkflowGraph(tx, ctx.organisationId, loaded.workflowId);
  const steps: TransitionResult[] = [];
  let job = loaded;
  const approved = await moveInto(tx, ctx, job, graph, "approved", confirm);
  if (!approved) throw new InvalidTransitionError(job.statusCategory, "approved", "This workflow has no Approve step from here");
  steps.push(approved);
  job = approved.job;

  let sharedWithClient = false;
  if (p.share === "send") {
    // Default: the current finished / gallery / download links go to the client with the job (plan §5
    // "Approve & send"); an explicit list (possibly empty) from the dialog wins.
    const shareLinkIds = p.shareLinkIds ?? (await currentLinksOfKinds(tx, job.id, SIMPLE_LINK_SLOTS.finished)).map((l) => l.id);
    const delivery = { shareJob: true, ...(shareLinkIds.length > 0 ? { shareLinkIds } : {}) };
    const delivered = await moveInto(tx, ctx, job, graph, "delivered", { ...confirm, delivery });
    if (delivered) {
      steps.push(delivered);
      job = delivered.job;
      sharedWithClient = delivered.delivery?.clientVisible ?? false;
      const completed = await moveInto(tx, ctx, job, graph, "completed", confirm);
      if (completed) {
        steps.push(completed);
        job = completed.job;
      }
    } else {
      // No Delivered status: the completing move IS the delivering move (engine §7.3). Stop at Approved when neither exists.
      const completed = await moveInto(tx, ctx, job, graph, "completed", { ...confirm, delivery });
      if (completed) {
        steps.push(completed);
        job = completed.job;
        sharedWithClient = completed.delivery?.clientVisible ?? false;
      }
    }
  } else if (p.share === "n/a") {
    const completed = await moveInto(tx, ctx, job, graph, "completed", confirm);
    if (completed) {
      steps.push(completed);
      job = completed.job;
    }
  }
  return {
    job,
    stage: jobStage(job),
    steps,
    stoppedAt: job.statusCategory,
    notSentToClient: p.share !== "send",
    sharedWithClient,
    selfApproved,
  };
}

/* ------------------------------------------------------------------ */
/*  Ask for changes                                                    */
/* ------------------------------------------------------------------ */

export interface AskForChangesResult extends SimpleJobResult {
  revision: JobRevision;
  transition: TransitionResult;
}

/**
 * Ask for changes (plan §5): one box "What needs changing?" (required) → the engine's revision request
 * with `reason` = the chips joined (or "Changes"), `description` = the note, assignee = the current
 * editor and "Needed back by" (default tomorrow in the org timezone). The round counter, the
 * `revision_requested` notice and Round N come from the engine as today.
 */
export async function askForChanges(tx: Tx, ctx: AuthContext, input: unknown): Promise<AskForChangesResult> {
  const p = parseInput(AskForChangesInput, input);
  const { job, ref } = await loadVisibleJob(tx, ctx, p.jobId);
  assertMayMoveJob(ctx, ref);
  if (selfReviewBlocked(ctx, ref)) throw new ForbiddenError("revision.request", "You can't check your own edit");
  requireStage(job, ["ready_to_check"], "Ask for changes");
  const chips = (p.chips ?? []).map((c) => c.trim()).filter((c) => c.length > 0);
  const reason = chips.length > 0 ? Array.from(new Set(chips)).join(", ") : SIMPLE_CHANGES_DEFAULT_REASON;
  const neededBy = p.neededBy ?? addCivilDays(todayCivil(ctx.settings.timezone, new Date(ctx.now())), SIMPLE_CHANGES_DEFAULT_DAYS);
  const result = await requestRevision(tx, ctx, {
    jobId: job.id,
    expectedVersion: p.expectedVersion,
    reason,
    description: p.note,
    dueDate: neededBy,
    ...(job.editorId ? { assigneeUserId: job.editorId } : {}),
  });
  return { job: result.job, stage: jobStage(result.job), revision: result.revision, transition: result };
}

/* ------------------------------------------------------------------ */
/*  Reopen                                                             */
/* ------------------------------------------------------------------ */

export interface ReopenJobSimpleResult extends SimpleJobResult {
  /** "client_changes": the recorded move into Changes asked (+ its revision). */
  transition: TransitionResult | null;
  /** "fix_delivery_link": the new client-visible link. */
  link: JobLink | null;
}

/**
 * The one Reopen on a Done job (plan §5 ⋯): "Client wants changes" goes to Changes asked (a recorded
 * revision request, reopening when the job was Completed; the editor must still be active); "Fix the
 * delivery link" keeps the job Done and records the replacement client-visible link (superseding the
 * current download link, shared when the client can see the job).
 */
export async function reopenJobSimple(tx: Tx, ctx: AuthContext, input: unknown): Promise<ReopenJobSimpleResult> {
  const p = parseInput(ReopenJobSimpleInput, input);
  const { job, ref } = await loadVisibleJob(tx, ctx, p.jobId);
  assertMayMoveJob(ctx, ref);
  requireStage(job, ["done"], "Reopen");
  assertVersion(job, p.expectedVersion);
  const label = SIMPLE_REOPEN_REASON_LABELS[p.reason];

  if (p.reason === "client_changes") {
    assertCan(ctx, job.statusCategory === "completed" ? "job.reopen" : "revision.request", ref);
    const graph = await loadWorkflowGraph(tx, ctx.organisationId, job.workflowId);
    const transition = await moveInto(tx, ctx, job, graph, "revision", {
      reason: label,
      revision: { reason: label, description: p.note?.trim() ? p.note.trim() : label, ...(job.editorId ? { assigneeUserId: job.editorId } : {}) },
    });
    if (!transition) throw new InvalidTransitionError(job.statusCategory, "revision", "This workflow has no way to ask for changes from here");
    return { job: transition.job, stage: jobStage(transition.job), transition, link: null };
  }

  // fix_delivery_link: stays Done.
  if (!p.newLink) throw new ValidationError("Paste the new delivery link", { formErrors: [], fieldErrors: { newLink: ["Required"] } });
  const current = await currentLinksOfKinds(tx, job.id, ["client_delivery", "gallery", "finished_files"]);
  const previous = current.find((l) => l.sharedWithClient) ?? current.find((l) => l.kind === "client_delivery") ?? null;
  let link: JobLink;
  if (previous && can(ctx, "link.replace", linkPermissionRef(ref, previous))) {
    link = (await replaceLink(tx, ctx, { linkId: previous.id, url: p.newLink.url, ...(p.newLink.label !== undefined ? { label: p.newLink.label } : {}) })).link;
  } else {
    link = await addLink(tx, ctx, { jobId: job.id, kind: "client_delivery", url: p.newLink.url, label: p.newLink.label ?? null });
  }
  if (isClientVisible(job, ref) && !link.sharedWithClient) {
    link = (await shareLink(tx, ctx, { linkId: link.id, shared: true })).link;
  }
  const fresh = await one(tx.select().from(jobs).where(eq(jobs.id, job.id)), "job");
  return { job: fresh, stage: jobStage(fresh), transition: null, link };
}

/* ------------------------------------------------------------------ */
/*  Cancel / restore                                                   */
/* ------------------------------------------------------------------ */

export async function cancelJobSimple(tx: Tx, ctx: AuthContext, input: unknown): Promise<SimpleJobResult & { transition: TransitionResult }> {
  const p = parseInput(CancelJobSimpleInput, input);
  const transition = await cancelJob(tx, ctx, { jobId: p.jobId, expectedVersion: p.expectedVersion, reason: p.reason });
  return { job: transition.job, stage: jobStage(transition.job), transition };
}

export async function restoreJobSimple(tx: Tx, ctx: AuthContext, input: unknown): Promise<SimpleJobResult & { transition: TransitionResult }> {
  const p = parseInput(RestoreJobSimpleInput, input);
  const transition = await restoreJob(tx, ctx, { jobId: p.jobId, expectedVersion: p.expectedVersion, reason: p.reason ?? null });
  return { job: transition.job, stage: jobStage(transition.job), transition };
}

/* ------------------------------------------------------------------ */
/*  Notifications & the "simpler" card                                 */
/* ------------------------------------------------------------------ */

/**
 * "Mark old updates as read" (plan §8): the actor's unread notifications of the types that are now off
 * by default are marked read. Nothing is deleted; `read_at` is the one mutable column (audit exemption).
 */
export async function markOldUpdatesRead(tx: Tx, ctx: AuthContext): Promise<{ updated: number }> {
  const userId = ctx.userId;
  if (!userId || ctx.isSystem) throw new UnauthorizedError();
  assertCan(ctx, "notification.read", { userId, organisationId: ctx.organisationId });
  const changed = await tx
    .update(notifications)
    .set({ readAt: ctx.now() })
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.organisationId, ctx.organisationId),
        isNull(notifications.readAt),
        inArray(notifications.type, [...DEFAULT_OFF_NOTIFICATION_TYPES]),
      ),
    )
    .returning({ id: notifications.id });
  return { updated: changed.length };
}

/** The one-time "Proofline got simpler" card (plan §6): dismissed per person, audited; idempotent. */
export async function dismissSimplerNotice(tx: Tx, ctx: AuthContext): Promise<SafeUser> {
  const userId = ctx.userId;
  if (!userId || ctx.isSystem) throw new UnauthorizedError();
  const me = await loadUserInOrg(tx, ctx, userId);
  if (me.simplerNoticeDismissedAt !== null) return safeUser(me);
  const now = ctx.now();
  const row = await one(
    tx
      .update(users)
      .set({ simplerNoticeDismissedAt: now, updatedAt: now, version: me.version + 1 })
      .where(and(eq(users.id, me.id), eq(users.version, me.version)))
      .returning(),
    "user",
  );
  await recordEvent(tx, ctx, {
    entityType: "user",
    entityId: me.id,
    eventType: "user.updated",
    action: "updated",
    previousValue: { simplerNoticeDismissedAt: null },
    newValue: { simplerNoticeDismissedAt: now },
    metadata: { targetUserId: me.id, targetName: me.name, self: true },
  });
  return safeUser(row);
}

/* ------------------------------------------------------------------ */
/*  Settings → Studio / People / Types of shoot                         */
/* ------------------------------------------------------------------ */

export interface SetAdvancedToolsResult {
  enabled: boolean;
  settings: OrganisationSettings;
  changed: boolean;
}

/** Settings → Studio → Advanced tools (plan §8): admin, audited as `settings.updated` field `advancedToolsEnabled`. */
export async function setAdvancedTools(tx: Tx, ctx: AuthContext, input: unknown): Promise<SetAdvancedToolsResult> {
  const p = parseInput(SetAdvancedToolsInput, input);
  const result = await updateSettings(tx, ctx, { expectedVersion: p.expectedVersion, advancedToolsEnabled: p.enabled });
  return { enabled: result.settings.advancedToolsEnabled, settings: result.settings, changed: result.changedFields.includes("advancedToolsEnabled") };
}

/**
 * "Usually handles up to N" per editor (plan §7): admin (`user.set_capacity`), editors only. Audited as
 * `user.capacity_changed` with the `usualCapacityJobs` field. Null clears it (the row shows no "of N").
 */
export async function setEditorUsualCapacity(tx: Tx, ctx: AuthContext, input: unknown): Promise<SafeUser> {
  const p = parseInput(SetEditorUsualCapacityInput, input);
  const target = await loadUserInOrg(tx, ctx, p.userId);
  assertCan(ctx, "user.set_capacity", userPermissionRef(target));
  if (target.role !== "editor") throw new UserRuleError("not_staff", "Only editors have a usual number of jobs", "usualCapacityJobs");
  if (target.anonymisedAt) throw new UserRuleError("invalid_target", "This user has been anonymised and can no longer be changed");
  checkVersion(target, p.expectedVersion, safeUser(target));
  if (target.usualCapacityJobs === p.usualCapacityJobs) return safeUser(target);
  const row = await one(
    tx
      .update(users)
      .set({ usualCapacityJobs: p.usualCapacityJobs, updatedAt: ctx.now(), version: target.version + 1 })
      .where(eq(users.id, target.id))
      .returning(),
    "user",
  );
  await recordEvent(tx, ctx, {
    entityType: "user",
    entityId: target.id,
    eventType: "user.capacity_changed",
    action: "updated",
    previousValue: { usualCapacityJobs: target.usualCapacityJobs, name: target.name },
    newValue: { usualCapacityJobs: row.usualCapacityJobs, name: row.name },
    metadata: { targetUserId: target.id, field: "usualCapacityJobs" },
  });
  return safeUser(row);
}

/** Settings → Types of shoot: usual days to edit (plan §5 default due date). Admin; audited as `job_type.updated`. */
export async function setJobTypeUsualDays(tx: Tx, ctx: AuthContext, input: unknown): Promise<JobType> {
  const p = parseInput(SetJobTypeUsualDaysInput, input);
  return updateJobType(tx, ctx, { jobTypeId: p.jobTypeId, expectedVersion: p.expectedVersion, usualDaysToEdit: p.usualDaysToEdit });
}

/* ------------------------------------------------------------------ */
/*  Close delivered jobs (plan §9)                                     */
/* ------------------------------------------------------------------ */

export interface CloseDeliveredJobsResult {
  ok: string[];
  failed: { id: string; code: AppError["code"]; message: string }[];
}

/**
 * "Close delivered jobs" (plan §9): owner-confirmed; every job sitting at Approved or Delivered is moved
 * to Completed one by one through the normal, recorded engine move (its own savepoint, so one failure —
 * a workflow without a Completed step, a stale row — never blocks the others). Nothing is bulk-updated.
 */
export async function closeDeliveredJobs(tx: Tx, ctx: AuthContext, input: unknown): Promise<CloseDeliveredJobsResult> {
  parseInput(CloseDeliveredJobsInput, input);
  assertCan(ctx, "job.complete");
  const rows = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.organisationId, ctx.organisationId), inArray(jobs.statusCategory, ["approved", "delivered"])))
    .orderBy(jobs.jobNumber, jobs.id);
  const ok: string[] = [];
  const failed: CloseDeliveredJobsResult["failed"] = [];
  for (const { id } of rows) {
    try {
      await withSavepoint(tx, (sp) => transitionLoadedJob(sp, ctx, id, { toCategory: "completed" }, { confirmSelfApproval: true, reason: "Closed from Close delivered jobs" }));
      ok.push(id);
    } catch (err) {
      failed.push(bulkFailure(id, err));
    }
  }
  return { ok, failed };
}

/* ------------------------------------------------------------------ */
/*  Read helper for the screens                                        */
/* ------------------------------------------------------------------ */

/**
 * The approve question the UI asks (decision 2): "ask" (Approve & send / Approve only) when the job's
 * client uses the portal, else "n/a" (the job finishes straight away and offers "Copy link").
 */
export async function approveShareChoiceFor(db: DbLike, ctx: AuthContext, jobId: string): Promise<ApproveShareChoice | "ask"> {
  const { job } = await loadVisibleJob(db, ctx, jobId);
  const row = await first(db.select({ portalEnabled: clients.portalEnabled, archivedAt: clients.archivedAt }).from(clients).where(eq(clients.id, job.clientId)));
  if (!row) throw new NotFoundError("Client");
  return row.portalEnabled && row.archivedAt === null ? "ask" : "n/a";
}
