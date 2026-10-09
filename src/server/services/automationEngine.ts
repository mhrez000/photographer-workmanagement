/**
 * Automation engine (ARCHITECTURE.md §7).
 *
 * Two halves:
 *   1. ENQUEUE — `enqueueAutomations(tx, ctx, event)` (./automationTriggers,
 *      re-exported here) runs inside the human transaction. It is called by
 *      `recordEvent()` for every event, so every mutation that writes a
 *      trigger event enqueues `pending` runs atomically with its evidence.
 *   2. EXECUTE — `runPendingAutomations(db, organisationId)` runs AFTER the
 *      outer transaction committed (`withTxThenAutomations` in ./_shared,
 *      the bulk runner, the sweep). Each run gets its own IMMEDIATE
 *      transaction and a system context stamped with the run id
 *      (`activity_events.automation_run_id`, `metadata.cause = "automation"`):
 *        pending → skipped                (kill switch, depth cap, rule disabled /
 *                                          archived, conditions not met)
 *        pending → matched → succeeded    (every action ok)
 *                          → failed       (≥ 1 action failed)
 *      Each ACTION runs in its own SAVEPOINT: a failing action is rolled back
 *      and recorded `{ ok: false, detail }` without undoing the other actions
 *      or other runs. Nothing is ever thrown to the caller; a run whose
 *      transaction dies unexpectedly is marked `failed` in a fresh one.
 *      Matched runs write `automation.ran`. Events written by actions enqueue
 *      child runs at `depth + 1`; runs deeper than AUTOMATION_MAX_DEPTH are
 *      skipped. The loop drains the queue (bounded passes).
 *   3. REPLAY — runs still `pending` after PENDING_REPLAY_AGE_SECONDS (lost
 *      between commit and execution) are re-run by the sweep; the run row is
 *      the dedupe key, so this is safe.
 */
import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db, DbLike, Tx } from "@/db/index";
import {
  activityEvents,
  automationRuns,
  automations,
  jobAssignments,
  jobs,
  notifications,
  users,
  workflowStatuses,
  type AutomationAction,
  type AutomationActionResult,
  type AutomationCondition,
  type AutomationTrigger,
} from "@/db/schema";
import {
  AUTOMATION_MAX_DEPTH,
  CATEGORY_GROUPS,
  NOTE_KIND_META,
  PRIORITY_META,
  STATUS_CATEGORY_META,
  WORKLOAD_BAND_META,
  type AutomationRunStatus,
  type WorkloadBand,
} from "@/lib/constants";
import { isPastDue } from "@/lib/metrics";
import type { ActivityEvent, AuthContext, Automation, AutomationDryRunResult, AutomationRun, Job } from "@/lib/types";
import { AutomationActionsSchema, AutomationConditionsSchema, AutomationTriggerSchema, parseJsonColumn } from "@/lib/validation/json";
import { recordEvent } from "@/server/audit";
import { systemContext } from "@/server/auth/session";
import { nowIso } from "@/server/clock";
import { AppError, NotFoundError, ValidationError } from "@/server/errors";
import { withTx } from "./_shared";
import { assignEditor } from "./assignments";
import { triggerMatches, triggerTypesForEvent } from "./automationTriggers";
import { applyJobFieldChanges } from "./jobs";
import { hasCurrentLinkOfKind } from "./links";
import { addNote } from "./notes";
import { managersOf, notify, ownersOf } from "./notifications";
import { jobLinkPath, loadVisibleJob, loadWorkflowGraph, movesFor, toWorkflowJob, transitionLoadedJob } from "./workflow";

export {
  DEADLINE_EVENT_FIELDS,
  TRIGGER_EVENT_TYPES,
  enqueueAutomations,
  triggerMatches,
  triggerTypesForEvent,
  type AutomationEventInput,
} from "./automationTriggers";

/** Pending runs older than this are considered lost and replayed by the sweep (§7). */
export const PENDING_REPLAY_AGE_SECONDS = 60;
/** Upper bound on drain passes per `runPendingAutomations` call (each pass = one chain level). */
export const MAX_DRAIN_PASSES = AUTOMATION_MAX_DEPTH + 3;

type Bag = Record<string, unknown>;

function bag(value: unknown): Bag {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Bag) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Message for a failed action / run: domain errors verbatim, never a stack. */
export function errorMessage(err: unknown): string {
  if (err instanceof AppError) return err.message;
  if (err instanceof Error && err.message) return err.message.slice(0, 500);
  return "Unexpected error";
}

/* ------------------------------------------------------------------ */
/*  Conditions                                                         */
/* ------------------------------------------------------------------ */

export interface ConditionResult {
  condition: AutomationCondition;
  met: boolean;
  detail: string;
}

export interface ConditionsEvaluation {
  met: boolean;
  results: ConditionResult[];
}

/** One condition against the CURRENT job state (null job → never met). */
export function evaluateCondition(db: DbLike, job: Job | null, condition: AutomationCondition, now: string): ConditionResult {
  if (!job) return { condition, met: false, detail: `${condition.field}: this trigger has no job` };
  const list = (values: readonly string[] | undefined) => (values ?? []).join(", ");
  switch (condition.field) {
    case "priority":
      return { condition, met: condition.values.includes(job.priority), detail: `priority is ${job.priority} (wanted ${list(condition.values)})` };
    case "statusCategory":
      return {
        condition,
        met: condition.values.includes(job.statusCategory),
        detail: `status category is ${job.statusCategory} (wanted ${list(condition.values)})`,
      };
    case "jobTypeId":
      return { condition, met: condition.values.includes(job.jobTypeId), detail: `job type ${condition.values.includes(job.jobTypeId) ? "matches" : "does not match"}` };
    case "clientId":
      return { condition, met: condition.values.includes(job.clientId), detail: `client ${condition.values.includes(job.clientId) ? "matches" : "does not match"}` };
    case "photographerId": {
      const met = job.photographerId !== null && condition.values.includes(job.photographerId);
      return { condition, met, detail: `photographer ${met ? "matches" : "does not match"}` };
    }
    case "editorId": {
      if (condition.op === "is_null") return { condition, met: job.editorId === null, detail: job.editorId ? "the job has an editor" : "the job has no editor" };
      if (condition.op === "is_not_null") return { condition, met: job.editorId !== null, detail: job.editorId ? "the job has an editor" : "the job has no editor" };
      const met = job.editorId !== null && (condition.values ?? []).includes(job.editorId);
      return { condition, met, detail: `editor ${met ? "matches" : "does not match"}` };
    }
    case "revisionCount": {
      const met = condition.op === "gte" ? job.revisionCount >= condition.value : job.revisionCount <= condition.value;
      return { condition, met, detail: `revision count is ${job.revisionCount} (wanted ${condition.op === "gte" ? "≥" : "≤"} ${condition.value})` };
    }
    case "isOverdue": {
      const overdue = CATEGORY_GROUPS.DEADLINE_BOUND.includes(job.statusCategory) && isPastDue(job.dueDate, now);
      return { condition, met: overdue === condition.value, detail: overdue ? "the job is overdue" : "the job is not overdue" };
    }
    case "hasLinkKind": {
      const exists = hasCurrentLinkOfKind(db, job.id, condition.kind);
      const met = condition.op === "exists" ? exists : !exists;
      return { condition, met, detail: `${exists ? "has" : "has no"} current ${condition.kind.replace(/_/g, " ")} link` };
    }
    default:
      return { condition, met: false, detail: "unknown condition" };
  }
}

/** AND of every condition (an empty list is met). */
export function evaluateConditions(db: DbLike, job: Job | null, conditions: readonly AutomationCondition[], now: string): ConditionsEvaluation {
  const results = conditions.map((c) => evaluateCondition(db, job, c, now));
  return { met: results.every((r) => r.met), results };
}

/* ------------------------------------------------------------------ */
/*  Actions                                                            */
/* ------------------------------------------------------------------ */

/** The trigger event as the actions need it. */
export interface TriggerEventInfo {
  id: string;
  eventType: string;
  entityType: string;
  entityId: string;
  previousValue: unknown;
  newValue: unknown;
  metadata: unknown;
}

interface ActionEnv {
  run: AutomationRun;
  automation: Automation;
  event: TriggerEventInfo | null;
  /** Position of the action in the rule (notification dedupe key). */
  index: number;
}

interface ActionOutcome {
  detail: string;
  activityEventId?: string;
}

function loadJobForRun(db: DbLike, ctx: AuthContext, jobId: string | null): Job | null {
  if (!jobId) return null;
  return db.select().from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.organisationId, ctx.organisationId))).get() ?? null;
}

function requireJob(job: Job | null): Job {
  if (!job) throw new ValidationError("This trigger has no job to act on");
  return job;
}

/** The user a workload_threshold event is about (its `entityId`). */
function workloadSubject(event: TriggerEventInfo | null): string | null {
  return event && event.eventType === "user.workload_band_changed" ? event.entityId : null;
}

/** Earliest editor ever assigned to the job. */
export function originalEditorOf(db: DbLike, jobId: string): string | null {
  const row = db
    .select({ userId: jobAssignments.userId })
    .from(jobAssignments)
    .where(and(eq(jobAssignments.jobId, jobId), eq(jobAssignments.role, "editor")))
    .orderBy(asc(jobAssignments.assignedAt), asc(sql`rowid`))
    .limit(1)
    .get();
  return row?.userId ?? null;
}

/** Recipients of a `notify` action (before notify()'s own active/prefs filtering). */
export function notifyRecipients(
  db: DbLike,
  organisationId: string,
  action: Extract<AutomationAction, { type: "notify" }>,
  job: Job | null,
  event: TriggerEventInfo | null,
): string[] {
  switch (action.target) {
    case "photographer":
      return job?.photographerId ? [job.photographerId] : [];
    case "editor": {
      const subject = workloadSubject(event);
      if (subject) return [subject];
      return job?.editorId ? [job.editorId] : [];
    }
    case "previous_editor":
      return job?.previousEditorId ? [job.previousEditorId] : [];
    case "creator":
      return job ? [job.createdByUserId] : [];
    case "managers":
      return managersOf(db, organisationId);
    case "owner":
      return ownersOf(db, organisationId);
    case "user":
      return action.userId ? [action.userId] : [];
    default:
      return [];
  }
}

/** Candidate editor of an `assign_editor` action (null = none on record). */
export function assignCandidate(db: DbLike, action: Extract<AutomationAction, { type: "assign_editor" }>, job: Job): string | null {
  if (action.target === "user") return action.userId ?? null;
  if (action.target === "previous_editor") return job.previousEditorId;
  return originalEditorOf(db, job.id);
}

function userName(db: DbLike, userId: string | null): string | null {
  if (!userId) return null;
  return db.select({ name: users.name }).from(users).where(eq(users.id, userId)).get()?.name ?? null;
}

function maxEventRowid(tx: Tx): number {
  return tx.select({ m: sql<number>`coalesce(max(rowid), 0)` }).from(activityEvents).get()?.m ?? 0;
}

/** First event this run wrote after `afterRowid` (the action's primary event). */
function firstRunEventSince(tx: Tx, runId: string, afterRowid: number): string | undefined {
  return tx
    .select({ id: activityEvents.id })
    .from(activityEvents)
    .where(and(eq(activityEvents.automationRunId, runId), sql`rowid > ${afterRowid}`))
    .orderBy(asc(sql`rowid`))
    .limit(1)
    .get()?.id;
}

/**
 * Users who already received a built-in (non-automation) notification about
 * `jobId` caused by the trigger event — the event itself or any event of the
 * same status transition (`metadata.transitionId`): e.g. `work_submitted`
 * hangs off `job.submitted` while a status_changed rule fires on
 * `job.status_changed` of the same move, and `job_overdue` hangs off the
 * `job.became_overdue` event an overdue rule fires on. A rule never sends
 * them a second notice for the same thing (ARCHITECTURE.md §7).
 */
export function alreadyNotifiedForTrigger(db: DbLike, organisationId: string, jobId: string | null, event: TriggerEventInfo | null): Set<string> {
  if (!jobId || !event) return new Set();
  const transitionId = str(bag(event.metadata).transitionId);
  const sameTrigger = transitionId
    ? sql`(${notifications.activityEventId} = ${event.id} OR ${notifications.activityEventId} IN (
        SELECT e.id FROM activity_events e
         WHERE e.organisation_id = ${organisationId} AND e.job_id = ${jobId}
           AND json_extract(e.metadata, '$.transitionId') = ${transitionId}))`
    : eq(notifications.activityEventId, event.id);
  return new Set(
    db
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(and(eq(notifications.organisationId, organisationId), eq(notifications.jobId, jobId), sql`${notifications.type} <> 'automation'`, sameTrigger))
      .all()
      .map((r) => r.userId),
  );
}

function performNotify(tx: Tx, ctx: AuthContext, action: Extract<AutomationAction, { type: "notify" }>, job: Job | null, env: ActionEnv): ActionOutcome {
  const subject = workloadSubject(env.event);
  if (!job && !subject && !["managers", "owner", "user"].includes(action.target)) {
    throw new ValidationError("This trigger has no job to take recipients from");
  }
  if (action.target === "user" && !action.userId) throw new ValidationError("No user chosen to notify");
  const candidates = notifyRecipients(tx, ctx.organisationId, action, job, env.event);
  if (candidates.length === 0) return { detail: `No ${action.target.replace(/_/g, " ")} to notify` };
  const covered = alreadyNotifiedForTrigger(tx, ctx.organisationId, job?.id ?? null, env.event);
  const recipients = candidates.filter((id) => !covered.has(id));
  if (recipients.length === 0) return { detail: "Already notified about this by the built-in notice" };

  let title: string;
  let body: string | null;
  let linkPath: string;
  if (job) {
    title = `${job.jobNumber}: ${env.automation.name}`;
    body = action.message ?? job.name;
    linkPath = jobLinkPath(job.id);
  } else {
    const next = bag(env.event?.newValue);
    const band = str(next.band) as WorkloadBand | null;
    const who = userName(tx, subject) ?? "An editor";
    title = env.automation.name;
    body = action.message ?? (band && band in WORKLOAD_BAND_META ? `${who}’s workload is ${WORKLOAD_BAND_META[band].label.toLowerCase()}` : null);
    linkPath = subject ? `/team/users/${subject}` : "/team/workloads";
  }
  const sent = notify(tx, ctx, {
    userIds: recipients,
    type: "automation",
    title,
    body,
    jobId: job?.id ?? null,
    activityEventId: env.event?.id ?? null,
    linkPath,
    dedupeKey: `automation:${env.run.id}:${env.index}`,
  });
  return { detail: sent.recipientIds.length === 0 ? "Nobody eligible to notify" : `Notified ${sent.recipientIds.length} user${sent.recipientIds.length === 1 ? "" : "s"}` };
}

function performAction(tx: Tx, ctx: AuthContext, action: AutomationAction, env: ActionEnv): ActionOutcome {
  const job = loadJobForRun(tx, ctx, env.run.jobId);
  const reason = `Automation: ${env.automation.name}`;
  switch (action.type) {
    case "notify":
      return performNotify(tx, ctx, action, job, env);
    case "assign_editor": {
      const current = requireJob(job);
      const candidate = assignCandidate(tx, action, current);
      if (!candidate) {
        throw new ValidationError(action.target === "previous_editor" ? "The job has no previous editor" : "The job has never had an editor");
      }
      if (candidate === current.editorId) return { detail: `${userName(tx, candidate) ?? "The editor"} already holds the job` };
      const result = assignEditor(tx, ctx, { jobId: current.id, userId: candidate, reason });
      return { detail: `Assigned ${userName(tx, candidate) ?? "editor"}${result.transition ? ` (now ${result.transition.toStatus.name})` : ""}` };
    }
    case "transition": {
      const current = requireJob(job);
      const label = STATUS_CATEGORY_META[action.toCategory].label;
      if (current.statusCategory === action.toCategory) return { detail: `Already ${label}` };
      const result = transitionLoadedJob(tx, ctx, current.id, { toCategory: action.toCategory }, { reason: action.reason ?? reason, cause: "automation" });
      return { detail: `Moved to ${result.toStatus.name}`, activityEventId: result.eventId };
    }
    case "set_priority": {
      const current = requireJob(job);
      if (current.priority === action.priority) return { detail: `Priority already ${PRIORITY_META[action.priority].label}` };
      const visible = loadVisibleJob(tx, ctx, current.id);
      applyJobFieldChanges(tx, ctx, visible.job, visible.ref, { priority: action.priority });
      return { detail: `Priority set to ${PRIORITY_META[action.priority].label}` };
    }
    case "add_note": {
      const current = requireJob(job);
      addNote(tx, ctx, { jobId: current.id, kind: action.kind, body: action.body });
      return { detail: `Added ${NOTE_KIND_META[action.kind].label.toLowerCase().replace(/s$/, "")}` };
    }
    default:
      throw new ValidationError("Unknown action");
  }
}

/* ------------------------------------------------------------------ */
/*  Execution                                                          */
/* ------------------------------------------------------------------ */

function loadTriggerEvent(db: DbLike, organisationId: string, eventId: string): TriggerEventInfo | null {
  const row = db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.id, eventId), eq(activityEvents.organisationId, organisationId)))
    .get();
  return row ? toTriggerEventInfo(row) : null;
}

function toTriggerEventInfo(row: ActivityEvent): TriggerEventInfo {
  return {
    id: row.id,
    eventType: row.eventType,
    entityType: row.entityType,
    entityId: row.entityId,
    previousValue: row.previousValue,
    newValue: row.newValue,
    metadata: row.metadata,
  };
}

function runContext(db: DbLike, organisationId: string, runId: string, requestId?: string): AuthContext {
  return systemContext(organisationId, { db, automationRunId: runId, cause: "automation", requestId });
}

interface FinishInput {
  status: Extract<AutomationRunStatus, "skipped" | "succeeded" | "failed">;
  results: AutomationActionResult[];
  error: string | null;
  conditions: AutomationCondition[];
  /** Write `automation.ran` (matched runs + unexpected failures). */
  audit: boolean;
}

function finishRun(tx: Tx, ctx: AuthContext, run: AutomationRun, automation: Automation | undefined, input: FinishInput): AutomationRunStatus {
  const now = ctx.now();
  tx.update(automationRuns)
    .set({
      status: input.status,
      actionsPerformed: input.results,
      conditionsSnapshot: input.conditions,
      error: input.error,
      startedAt: run.startedAt ?? now,
      finishedAt: now,
    })
    .where(and(eq(automationRuns.id, run.id), isNull(automationRuns.finishedAt)))
    .run();
  if (input.audit) {
    recordEvent(tx, ctx, {
      entityType: "automation_run",
      entityId: run.id,
      jobId: run.jobId,
      eventType: "automation.ran",
      action: "ran",
      previousValue: null,
      newValue: { status: input.status, actionsPerformed: input.results },
      metadata: {
        automationRunId: run.id,
        automationId: run.automationId,
        automationName: automation?.name ?? null,
        triggerEventId: run.triggerEventId,
        depth: run.depth,
        ...(input.error ? { error: input.error } : {}),
      },
    });
  }
  return input.status;
}

function executeRunInTx(tx: Tx, organisationId: string, runId: string, requestId?: string): AutomationRunStatus | null {
  const run = tx
    .select()
    .from(automationRuns)
    .where(and(eq(automationRuns.id, runId), eq(automationRuns.organisationId, organisationId)))
    .get();
  if (!run || run.status !== "pending" || run.finishedAt !== null) return null;
  const automation = tx.select().from(automations).where(eq(automations.id, run.automationId)).get();
  const ctx = runContext(tx, organisationId, run.id, requestId);
  const conditions = automation ? parseJsonColumn(AutomationConditionsSchema, automation.conditions, []) : [];
  const skip = (reason: string) => finishRun(tx, ctx, run, automation, { status: "skipped", results: [], error: reason, conditions, audit: false });

  if (!ctx.settings.automationsEnabled) return skip("Automations are switched off for this organisation");
  if (run.depth > AUTOMATION_MAX_DEPTH) return skip(`Chain depth ${run.depth} exceeds the limit of ${AUTOMATION_MAX_DEPTH}`);
  if (!automation || automation.archivedAt !== null) return skip("The rule was archived");
  if (!automation.isEnabled) return skip("The rule is disabled");
  const actions = parseJsonColumn(AutomationActionsSchema, automation.actions, []);
  if (actions.length === 0) return skip("The rule has no valid actions");

  const now = ctx.now();
  const event = loadTriggerEvent(tx, organisationId, run.triggerEventId);
  const job = loadJobForRun(tx, ctx, run.jobId);
  const evaluation = evaluateConditions(tx, job, conditions, now);
  if (!evaluation.met) {
    const failing = evaluation.results.find((r) => !r.met);
    return skip(`Condition not met: ${failing?.detail ?? "unknown"}`);
  }

  tx.update(automationRuns).set({ status: "matched", startedAt: now, conditionsSnapshot: conditions }).where(eq(automationRuns.id, run.id)).run();
  const matchedRun: AutomationRun = { ...run, status: "matched", startedAt: now };

  const results: AutomationActionResult[] = [];
  actions.forEach((action, index) => {
    const before = maxEventRowid(tx);
    try {
      const outcome = tx.transaction((sp) => performAction(sp, ctx, action, { run: matchedRun, automation, event, index }));
      const activityEventId = outcome.activityEventId ?? firstRunEventSince(tx, run.id, before);
      results.push({ action, ok: true, detail: outcome.detail, ...(activityEventId ? { activityEventId } : {}) });
    } catch (err) {
      results.push({ action, ok: false, detail: errorMessage(err) });
    }
  });

  const failures = results.filter((r) => !r.ok);
  return finishRun(tx, ctx, matchedRun, automation, {
    status: failures.length === 0 ? "succeeded" : "failed",
    results,
    error: failures.length === 0 ? null : failures.map((f) => `${f.action.type}: ${f.detail ?? "failed"}`).join("; "),
    conditions,
    audit: true,
  });
}

/** Marks a run whose transaction died as failed (fresh transaction). */
function failRunInTx(tx: Tx, organisationId: string, runId: string, message: string, requestId?: string): AutomationRunStatus | null {
  const run = tx
    .select()
    .from(automationRuns)
    .where(and(eq(automationRuns.id, runId), eq(automationRuns.organisationId, organisationId)))
    .get();
  if (!run || run.finishedAt !== null) return null;
  const automation = tx.select().from(automations).where(eq(automations.id, run.automationId)).get();
  const ctx = runContext(tx, organisationId, run.id, requestId);
  const conditions = automation ? parseJsonColumn(AutomationConditionsSchema, automation.conditions, []) : [];
  return finishRun(tx, ctx, run, automation, { status: "failed", results: [], error: message, conditions, audit: true });
}

/**
 * Executes one pending run in its own transaction. Never throws: returns the
 * final status, or null when the run was not pending (already handled).
 */
export function executeAutomationRun(db: Db, organisationId: string, runId: string, opts: { requestId?: string } = {}): AutomationRunStatus | null {
  try {
    return withTx((tx) => executeRunInTx(tx, organisationId, runId, opts.requestId), { db });
  } catch (err) {
    try {
      return withTx((tx) => failRunInTx(tx, organisationId, runId, errorMessage(err), opts.requestId), { db });
    } catch {
      return null;
    }
  }
}

export interface RunPendingOptions {
  /** Only runs created at least this many seconds ago (replay of lost runs). */
  olderThanSeconds?: number;
  /** Max runs fetched per pass (default 500). */
  limit?: number;
  /** Drain passes (default MAX_DRAIN_PASSES); each pass picks up the runs the previous one enqueued. */
  maxPasses?: number;
  requestId?: string;
}

export interface RunPendingResult {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  runIds: string[];
}

export function emptyRunPendingResult(): RunPendingResult {
  return { processed: 0, succeeded: 0, failed: 0, skipped: 0, runIds: [] };
}

const draining = new Set<string>();

/**
 * Executes the organisation's pending runs, oldest first, after the caller's
 * transaction committed. Drains chained runs (bounded). Never throws; a
 * nested call for an org already draining returns immediately (the outer
 * loop picks the new runs up).
 */
export function runPendingAutomations(db: Db, organisationId: string, opts: RunPendingOptions = {}): RunPendingResult {
  const result = emptyRunPendingResult();
  if (draining.has(organisationId)) return result;
  draining.add(organisationId);
  try {
    const cutoff = opts.olderThanSeconds !== undefined ? new Date(Date.parse(nowIso()) - opts.olderThanSeconds * 1000).toISOString() : null;
    const attempted = new Set<string>();
    const passes = opts.maxPasses ?? MAX_DRAIN_PASSES;
    for (let pass = 0; pass < passes; pass++) {
      let pending: { id: string }[];
      try {
        pending = db
          .select({ id: automationRuns.id })
          .from(automationRuns)
          .where(
            and(
              eq(automationRuns.organisationId, organisationId),
              eq(automationRuns.status, "pending"),
              cutoff ? lte(automationRuns.createdAt, cutoff) : undefined,
            ),
          )
          .orderBy(asc(automationRuns.createdAt), asc(sql`rowid`))
          .limit(opts.limit ?? 500)
          .all()
          .filter((r) => !attempted.has(r.id));
      } catch {
        break;
      }
      if (pending.length === 0) break;
      for (const { id } of pending) {
        attempted.add(id);
        const status = executeAutomationRun(db, organisationId, id, { requestId: opts.requestId });
        if (status === null) continue;
        result.processed += 1;
        result.runIds.push(id);
        if (status === "succeeded") result.succeeded += 1;
        else if (status === "failed") result.failed += 1;
        else if (status === "skipped") result.skipped += 1;
      }
    }
  } finally {
    draining.delete(organisationId);
  }
  return result;
}

/** Sweep hook: re-runs pending runs older than PENDING_REPLAY_AGE_SECONDS (§7 replay). */
export function replayStalePendingRuns(db: Db, organisationId: string, olderThanSeconds = PENDING_REPLAY_AGE_SECONDS): RunPendingResult {
  return runPendingAutomations(db, organisationId, { olderThanSeconds });
}

/* ------------------------------------------------------------------ */
/*  Dry run                                                            */
/* ------------------------------------------------------------------ */

/** Event types that can fire a trigger type (dry-run event lookup). */
const TRIGGER_SOURCE_EVENTS: Record<AutomationTrigger["type"], readonly string[]> = {
  job_created: ["job.created"],
  status_changed: ["job.status_changed"],
  job_assigned: ["assignment.created"],
  job_reassigned: ["assignment.created"],
  deadline_changed: ["job.due_date_changed", "job.review_due_date_changed", "job.delivery_due_date_changed"],
  priority_changed: ["job.priority_changed"],
  revision_requested: ["revision.requested"],
  job_overdue: ["job.became_overdue"],
  workload_threshold: ["user.workload_band_changed"],
};

function statusKeyLookup(db: DbLike, organisationId: string): (statusId: string) => string | null {
  return (statusId) =>
    db
      .select({ key: workflowStatuses.key })
      .from(workflowStatuses)
      .where(and(eq(workflowStatuses.id, statusId), eq(workflowStatuses.organisationId, organisationId)))
      .get()?.key ?? null;
}

function previewAction(db: DbLike, sys: AuthContext, action: AutomationAction, job: Job, automation: Automation): { description: string; problem: string | null } {
  switch (action.type) {
    case "notify": {
      const ids = notifyRecipients(db, sys.organisationId, action, job, null);
      const names = ids.length
        ? db
            .select({ name: users.name, isActive: users.isActive })
            .from(users)
            .where(and(inArray(users.id, ids), eq(users.organisationId, sys.organisationId)))
            .all()
            .filter((u) => u.isActive)
            .map((u) => u.name)
        : [];
      return names.length
        ? { description: `Notify ${names.join(", ")}${action.message ? `: “${action.message}”` : ""}`, problem: null }
        : { description: `Notify the ${action.target.replace(/_/g, " ")}`, problem: "Nobody to notify for this job" };
    }
    case "assign_editor": {
      const candidate = assignCandidate(db, action, job);
      if (!candidate) return { description: `Assign the ${action.target.replace(/_/g, " ")}`, problem: "No such editor on record for this job" };
      const user = db.select().from(users).where(and(eq(users.id, candidate), eq(users.organisationId, sys.organisationId))).get();
      if (!user) return { description: "Assign an editor", problem: "The editor is not in this organisation" };
      if (candidate === job.editorId) return { description: `Assign ${user.name}`, problem: `${user.name} already holds the job (no change)` };
      if (!user.isActive || user.role !== "editor") return { description: `Assign ${user.name}`, problem: `${user.name} is not an active editor` };
      if (job.statusCategory === "cancelled") return { description: `Assign ${user.name}`, problem: "Cancelled jobs cannot be reassigned" };
      return { description: `Assign ${user.name} as editor`, problem: null };
    }
    case "transition": {
      const label = STATUS_CATEGORY_META[action.toCategory].label;
      if (job.statusCategory === action.toCategory) return { description: `Move to ${label}`, problem: `Already ${label} (no change)` };
      const graph = loadWorkflowGraph(db, sys.organisationId, job.workflowId);
      const moves = movesFor(sys, toWorkflowJob(db, job), graph).filter((m) => m.toStatus.category === action.toCategory);
      if (moves.length === 0) return { description: `Move to ${label}`, problem: `No workflow edge lets an automation move this job to ${label}` };
      if (moves.length > 1) return { description: `Move to ${label}`, problem: `Several ${label} statuses match: ${moves.map((m) => m.toStatus.name).join(", ")}` };
      return { description: `Move to ${moves[0]?.toStatus.name ?? label}`, problem: moves[0]?.requiresRevisionPayload ? "A revision request needs details an automation cannot supply" : null };
    }
    case "set_priority":
      return job.priority === action.priority
        ? { description: `Set priority to ${PRIORITY_META[action.priority].label}`, problem: "Already that priority (no change)" }
        : { description: `Set priority to ${PRIORITY_META[action.priority].label}`, problem: null };
    case "add_note": {
      const preview = action.body.length > 80 ? `${action.body.slice(0, 77)}…` : action.body;
      return { description: `Add a ${NOTE_KIND_META[action.kind].label.toLowerCase().replace(/s$/, "")}: “${preview}”`, problem: null };
    }
    default:
      return { description: `Unknown action in ${automation.name}`, problem: "Unknown action" };
  }
}

/**
 * Evaluates `automation` against `job` without writing anything: the
 * trigger against the job's latest matching event (or `triggerEventId`),
 * every condition against the current job, and a preview of each action.
 */
export function dryRunAutomation(
  db: DbLike,
  ctx: AuthContext,
  automation: Automation,
  job: Job,
  opts: { triggerEventId?: string } = {},
): AutomationDryRunResult {
  const now = ctx.now();
  const trigger = parseJsonColumn(AutomationTriggerSchema, automation.trigger, { type: "job_created" });
  const conditions = parseJsonColumn(AutomationConditionsSchema, automation.conditions, []);
  const actions = parseJsonColumn(AutomationActionsSchema, automation.actions, []);
  const statusKeyOf = statusKeyLookup(db, ctx.organisationId);

  let triggerResult: AutomationDryRunResult["trigger"];
  if (trigger.type === "workload_threshold") {
    triggerResult = { type: trigger.type, matched: null, eventId: null, detail: "Workload triggers fire for an editor, not a job" };
  } else if (opts.triggerEventId) {
    const event = loadTriggerEvent(db, ctx.organisationId, opts.triggerEventId);
    const row = event ? db.select({ jobId: activityEvents.jobId }).from(activityEvents).where(eq(activityEvents.id, event.id)).get() : undefined;
    if (!event || row?.jobId !== job.id) throw new NotFoundError("Event");
    const matched = triggerMatches(trigger, event, statusKeyOf);
    triggerResult = { type: trigger.type, matched, eventId: event.id, detail: matched ? `Matches ${event.eventType}` : `${event.eventType} does not match this trigger` };
  } else {
    const candidates = db
      .select()
      .from(activityEvents)
      .where(
        and(
          eq(activityEvents.organisationId, ctx.organisationId),
          eq(activityEvents.jobId, job.id),
          inArray(activityEvents.eventType, [...TRIGGER_SOURCE_EVENTS[trigger.type]]),
        ),
      )
      .orderBy(desc(activityEvents.createdAt), desc(sql`rowid`))
      .limit(200)
      .all()
      .filter((e) => triggerTypesForEvent(e.eventType, e.previousValue).includes(trigger.type));
    const hit = candidates.find((e) => triggerMatches(trigger, toTriggerEventInfo(e), statusKeyOf));
    if (hit) triggerResult = { type: trigger.type, matched: true, eventId: hit.id, detail: `Matches ${hit.eventType} at ${hit.createdAt}` };
    else if (candidates[0]) triggerResult = { type: trigger.type, matched: false, eventId: candidates[0].id, detail: `The job's ${candidates[0].eventType} events do not match the trigger filters` };
    else triggerResult = { type: trigger.type, matched: null, eventId: null, detail: "No event on this job has fired this trigger yet" };
  }

  const evaluation = evaluateConditions(db, job, conditions, now);
  const settingsOn = ctx.settings.automationsEnabled;
  const blockedBy = !settingsOn
    ? "Automations are switched off for this organisation"
    : automation.archivedAt !== null
      ? "The rule is archived"
      : !automation.isEnabled
        ? "The rule is disabled"
        : null;
  const sys = systemContext(ctx.organisationId, { db, cause: "automation", requestId: ctx.requestId, now: ctx.now });

  return {
    automationId: automation.id,
    job: { id: job.id, jobNumber: job.jobNumber, name: job.name },
    trigger: triggerResult,
    conditions: evaluation.results,
    conditionsMet: evaluation.met,
    blockedBy,
    wouldRun: blockedBy === null && evaluation.met && triggerResult.matched !== false,
    actions: actions.map((action) => ({ action, ...previewAction(db, sys, action, job, automation) })),
  };
}
