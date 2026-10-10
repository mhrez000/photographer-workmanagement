/**
 * Time tracking (ARCHITECTURE.md §2.4 work_sessions, §3.2 timer rows, §5
 * work_session.* events).
 *
 * - Honours `organisation_settings.time_tracking_enabled` (starting a timer
 *   is refused when off; stopping an already-running one is always allowed).
 * - One running timer per user (partial unique index on `user_id WHERE
 *   ended_at IS NULL`): starting on another job is a 409 unless
 *   `switchFromRunning` asks to stop the other one first.
 * - A session snapshots the job's status, category and the open
 *   job_status_transitions row it ran in; `ended_at`, `end_reason` and
 *   `duration_seconds` are fill-once.
 * - `closeSessionsForJob` / `closeRunningSessionForUser` are the engine hooks
 *   the workflow / assignment / user services call inside their own
 *   transaction (no permission check: the caller already authorised the
 *   mutation that causes the close).
 */
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { first, one, type DbLike, type Tx } from "@/db/index";
import { jobStatusTransitions, jobs, organisationSettings, workSessions } from "@/db/schema";
import { CATEGORY_GROUPS, type SessionEndReason, type StatusCategory } from "@/lib/constants";
import type { AuthContext, Job, RunningSessionView, SessionTotals, WorkSession, WorkSessionView } from "@/lib/types";
import { durationSeconds } from "@/lib/metrics";
import { EndTimerInput, StartTimerInput } from "@/lib/validation/timeTracking";
import { assertCan, can, isManagement } from "@/server/auth/permissions";
import { recordEvent } from "@/server/audit";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { jobMeta, loadJobWithRef, loadUserRefMap, unknownUserRef } from "./_collab";
import { parseInput } from "./_shared";

/** `metadata.closedBy` of work_session.ended events (§5). */
export type WorkSessionClosedBy = "user" | "switch" | "submit" | "reassign" | "complete" | "deactivate" | "timeout" | "status_change";

const DEFAULT_CLOSED_BY: Record<SessionEndReason, WorkSessionClosedBy> = {
  paused: "user",
  stopped: "user",
  auto_status_change: "status_change",
  auto_reassigned: "reassign",
  auto_timeout: "timeout",
  auto_deactivated: "deactivate",
};

export interface CloseSessionOptions {
  /** Overrides the default `metadata.closedBy` derived from the end reason (e.g. "submit", "complete"). */
  closedBy?: WorkSessionClosedBy;
  /** Explicit end instant (default `ctx.now()`); clamped to ≥ started_at. */
  endedAt?: string;
  /** Extra event metadata (e.g. transitionId, batchId). */
  metadata?: Record<string, unknown>;
}

const TERMINAL = CATEGORY_GROUPS.TERMINAL;

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                   */
/* ------------------------------------------------------------------ */

async function runningForUser(db: DbLike, organisationId: string, userId: string): Promise<WorkSession | undefined> {
  return first(
    db
      .select()
      .from(workSessions)
      .where(and(eq(workSessions.organisationId, organisationId), eq(workSessions.userId, userId), isNull(workSessions.endedAt)))
      .limit(1),
  );
}

async function jobLabel(db: DbLike, ctx: AuthContext, jobId: string): Promise<Pick<Job, "id" | "jobNumber" | "name"> | undefined> {
  return first(
    db
      .select({ id: jobs.id, jobNumber: jobs.jobNumber, name: jobs.name })
      .from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.organisationId, ctx.organisationId))),
  );
}

/**
 * Closes one open session (fill-once) and writes `work_session.ended`.
 * Returns null when the row was already closed (lost a race).
 */
async function endSession(
  tx: Tx,
  ctx: AuthContext,
  session: WorkSession,
  reason: SessionEndReason,
  opts: CloseSessionOptions & { note?: string | null; job?: Pick<Job, "jobNumber" | "name"> } = {},
): Promise<WorkSession | null> {
  const requested = opts.endedAt ?? ctx.now();
  const endedAt = requested < session.startedAt ? session.startedAt : requested;
  const seconds = durationSeconds(session.startedAt, endedAt, endedAt);
  const closed = await first(
    tx
      .update(workSessions)
      .set({
        endedAt,
        endReason: reason,
        durationSeconds: seconds,
        ...(opts.note !== undefined && opts.note !== null ? { note: opts.note } : {}),
      })
      .where(and(eq(workSessions.id, session.id), isNull(workSessions.endedAt)))
      .returning(),
  );
  if (!closed) return null;

  const job = opts.job ?? (await jobLabel(tx, ctx, session.jobId));
  await recordEvent(tx, ctx, {
    entityType: "work_session",
    entityId: session.id,
    jobId: session.jobId,
    eventType: "work_session.ended",
    action: reason === "paused" ? "paused" : "stopped",
    previousValue: { startedAt: session.startedAt },
    newValue: { endedAt, durationSeconds: seconds, endReason: reason },
    metadata: {
      ...opts.metadata,
      sessionId: session.id,
      sessionUserId: session.userId,
      closedBy: opts.closedBy ?? DEFAULT_CLOSED_BY[reason],
      ...(ctx.userId && ctx.userId !== session.userId ? { onBehalfOf: session.userId } : {}),
      ...(job ? jobMeta(job) : {}),
    },
  });
  return closed;
}

/* ------------------------------------------------------------------ */
/*  startTimer / pauseTimer / stopTimer                                */
/* ------------------------------------------------------------------ */

export interface StartTimerResult {
  session: WorkSession;
  /** The actor's timer was already running on this job (no new row). */
  alreadyRunning: boolean;
  /** The session stopped on another job because `switchFromRunning` was set. */
  stopped: WorkSession | null;
}

/**
 * Starts the actor's timer on a job. Requires org time tracking on and
 * `timer.use` (O/M: jobs assigned to self; P: own jobs; E: assigned jobs in
 * EDITOR_WORKING). Refused on terminal or paused jobs.
 */
export async function startTimer(tx: Tx, ctx: AuthContext, input: unknown): Promise<StartTimerResult> {
  const data = parseInput(StartTimerInput, input);
  const { job, ref } = await loadJobWithRef(tx, ctx, data.jobId);
  if (!ctx.settings.timeTrackingEnabled) {
    throw new ForbiddenError("timer.use", "Time tracking is turned off for this organisation");
  }
  assertCan(ctx, "timer.use", ref);
  const userId = ctx.userId;
  if (!userId) throw new ForbiddenError("timer.use");
  if (TERMINAL.includes(job.statusCategory)) throw new ValidationError("The timer can't run on a completed or cancelled job");
  if (job.isPaused) throw new ValidationError("Resume work on the job before starting the timer");

  const running = await runningForUser(tx, ctx.organisationId, userId);
  let stopped: WorkSession | null = null;
  if (running) {
    if (running.jobId === job.id) return { session: running, alreadyRunning: true, stopped: null };
    if (!data.switchFromRunning) {
      const other = await jobLabel(tx, ctx, running.jobId);
      throw new ConflictError(`Your timer is already running on ${other?.jobNumber ?? "another job"}. Stop it first.`, running);
    }
    stopped = await endSession(tx, ctx, running, "stopped", { closedBy: "switch", metadata: { switchedToJobId: job.id } });
  }

  const transition = await first(
    tx
      .select({ id: jobStatusTransitions.id })
      .from(jobStatusTransitions)
      .where(and(eq(jobStatusTransitions.jobId, job.id), isNull(jobStatusTransitions.exitedAt)))
      .limit(1),
  );
  if (!transition) throw new ConflictError("The job has no open stage. Reload and try again.", job);

  const session = await one(
    tx
      .insert(workSessions)
      .values({
        organisationId: ctx.organisationId,
        jobId: job.id,
        userId,
        statusIdAtStart: job.statusId,
        categoryAtStart: job.statusCategory,
        transitionId: transition.id,
        startedAt: ctx.now(),
        note: data.note ?? null,
      })
      .returning(),
    "work session",
  );

  await recordEvent(tx, ctx, {
    entityType: "work_session",
    entityId: session.id,
    jobId: job.id,
    eventType: "work_session.started",
    action: "started",
    previousValue: null,
    newValue: { sessionId: session.id, statusId: job.statusId, category: job.statusCategory, transitionId: transition.id },
    metadata: { sessionId: session.id, ...jobMeta(job) },
  });
  return { session, alreadyRunning: false, stopped };
}

async function endTimer(tx: Tx, ctx: AuthContext, input: unknown, reason: "paused" | "stopped"): Promise<WorkSession> {
  const data = parseInput(EndTimerInput, input);
  const userId = ctx.userId;
  if (!userId) throw new ForbiddenError("timer.use");

  let session: WorkSession | undefined;
  if (data.sessionId) {
    session = await first(
      tx
        .select()
        .from(workSessions)
        .where(and(eq(workSessions.id, data.sessionId), eq(workSessions.organisationId, ctx.organisationId))),
    );
    if (!session || (data.jobId && session.jobId !== data.jobId)) throw new NotFoundError("Timer");
    if (session.userId !== userId) {
      // Someone else's timer: owners/managers only (and only on jobs they can see).
      const { ref } = await loadJobWithRef(tx, ctx, session.jobId);
      if (!isManagement(ctx) || !can(ctx, "timer.view_others", ref)) throw new ForbiddenError("timer.use");
    }
    if (session.endedAt) return session;
  } else {
    session = await runningForUser(tx, ctx.organisationId, userId);
    if (!session || (data.jobId && session.jobId !== data.jobId)) throw new NotFoundError("Running timer");
  }

  const closed = await endSession(tx, ctx, session, reason, { note: data.note });
  if (!closed) throw new ConflictError("The timer was already stopped. Reload and try again.");
  return closed;
}

/** Pauses the actor's running timer (`end_reason = paused`; resuming starts a new session). */
export async function pauseTimer(tx: Tx, ctx: AuthContext, input: unknown): Promise<WorkSession> {
  return endTimer(tx, ctx, input, "paused");
}

/** Stops the actor's running timer (`end_reason = stopped`). */
export async function stopTimer(tx: Tx, ctx: AuthContext, input: unknown): Promise<WorkSession> {
  return endTimer(tx, ctx, input, "stopped");
}

/* ------------------------------------------------------------------ */
/*  Engine hooks (called by workflow / assignments / users / sweep)    */
/* ------------------------------------------------------------------ */

/** Object form of the engine hooks' arguments. */
export interface CloseSessionsForJobArgs extends CloseSessionOptions {
  jobId: string;
  reason: SessionEndReason;
}
export interface CloseRunningSessionArgs extends CloseSessionOptions {
  userId: string;
  reason: SessionEndReason;
}

/**
 * Closes every running session on a job (any user) with `reason`, writing
 * one `work_session.ended` per session. Used on submit/resubmit
 * (`auto_status_change`), completion, cancellation and reassignment.
 * Accepts `(tx, ctx, jobId, reason, opts?)` or `(tx, ctx, { jobId, reason, ...opts })`.
 */
export function closeSessionsForJob(
  tx: Tx,
  ctx: AuthContext,
  jobId: string,
  reason: SessionEndReason,
  opts?: CloseSessionOptions,
): Promise<WorkSession[]>;
export function closeSessionsForJob(tx: Tx, ctx: AuthContext, args: CloseSessionsForJobArgs): Promise<WorkSession[]>;
export async function closeSessionsForJob(
  tx: Tx,
  ctx: AuthContext,
  jobIdOrArgs: string | CloseSessionsForJobArgs,
  reasonArg?: SessionEndReason,
  optsArg: CloseSessionOptions = {},
): Promise<WorkSession[]> {
  const { jobId, reason, ...opts } =
    typeof jobIdOrArgs === "string" ? { ...optsArg, jobId: jobIdOrArgs, reason: requireReason(reasonArg) } : jobIdOrArgs;
  const open = await tx
    .select()
    .from(workSessions)
    .where(and(eq(workSessions.organisationId, ctx.organisationId), eq(workSessions.jobId, jobId), isNull(workSessions.endedAt)))
    .orderBy(asc(workSessions.startedAt), asc(workSessions.id));
  if (open.length === 0) return [];
  const job = await jobLabel(tx, ctx, jobId);
  const closed: WorkSession[] = [];
  for (const s of open) {
    const row = await endSession(tx, ctx, s, reason, { ...opts, job });
    if (row) closed.push(row);
  }
  return closed;
}

function requireReason(reason: SessionEndReason | undefined): SessionEndReason {
  if (!reason) throw new Error("timeTracking: an end reason is required");
  return reason;
}

/**
 * Closes `userId`'s running session (on whatever job) with `reason`.
 * Returns the closed row, or null when the user had no running timer.
 * Accepts `(tx, ctx, userId, reason, opts?)` or `(tx, ctx, { userId, reason, ...opts })`.
 */
export function closeRunningSessionForUser(
  tx: Tx,
  ctx: AuthContext,
  userId: string,
  reason: SessionEndReason,
  opts?: CloseSessionOptions,
): Promise<WorkSession | null>;
export function closeRunningSessionForUser(tx: Tx, ctx: AuthContext, args: CloseRunningSessionArgs): Promise<WorkSession | null>;
export async function closeRunningSessionForUser(
  tx: Tx,
  ctx: AuthContext,
  userIdOrArgs: string | CloseRunningSessionArgs,
  reasonArg?: SessionEndReason,
  optsArg: CloseSessionOptions = {},
): Promise<WorkSession | null> {
  const { userId, reason, ...opts } =
    typeof userIdOrArgs === "string" ? { ...optsArg, userId: userIdOrArgs, reason: requireReason(reasonArg) } : userIdOrArgs;
  const running = await runningForUser(tx, ctx.organisationId, userId);
  if (!running) return null;
  return endSession(tx, ctx, running, reason, opts);
}

/**
 * Sweep hook: closes sessions running longer than the org's
 * `work_session_auto_timeout_minutes` (`auto_timeout`), ended at
 * `started_at + timeout` (never later than now).
 */
export async function closeTimedOutSessions(tx: Tx, ctx: AuthContext, opts: { timeoutMinutes?: number } = {}): Promise<WorkSession[]> {
  const timeoutMinutes =
    opts.timeoutMinutes ??
    (
      await first(
        tx
          .select({ minutes: organisationSettings.workSessionAutoTimeoutMinutes })
          .from(organisationSettings)
          .where(eq(organisationSettings.organisationId, ctx.organisationId))
          .limit(1),
      )
    )?.minutes ??
    600;
  const now = ctx.now();
  const nowMs = Date.parse(now);
  const timeoutMs = timeoutMinutes * 60_000;
  const open = (
    await tx
      .select()
      .from(workSessions)
      .where(and(eq(workSessions.organisationId, ctx.organisationId), isNull(workSessions.endedAt)))
      .orderBy(asc(workSessions.startedAt), asc(workSessions.id))
  ).filter((s) => nowMs - Date.parse(s.startedAt) > timeoutMs);
  const closed: WorkSession[] = [];
  for (const s of open) {
    const endedAt = new Date(Math.min(nowMs, Date.parse(s.startedAt) + timeoutMs)).toISOString();
    const row = await endSession(tx, ctx, s, "auto_timeout", { endedAt });
    if (row) closed.push(row);
  }
  return closed;
}

/* ------------------------------------------------------------------ */
/*  Reads                                                              */
/* ------------------------------------------------------------------ */

async function toViews(db: DbLike, ctx: AuthContext, rows: readonly WorkSession[]): Promise<WorkSessionView[]> {
  if (rows.length === 0) return [];
  const now = ctx.now();
  const people = await loadUserRefMap(db, ctx, rows.map((r) => r.userId));
  const transitionIds = Array.from(new Set(rows.map((r) => r.transitionId)));
  const transitions = await db
    .select({ id: jobStatusTransitions.id, statusName: jobStatusTransitions.statusName })
    .from(jobStatusTransitions)
    .where(inArray(jobStatusTransitions.id, transitionIds));
  const names = new Map(transitions.map((t) => [t.id, t.statusName]));
  return rows.map((r) => ({
    id: r.id,
    user: people.get(r.userId) ?? unknownUserRef(r.userId),
    statusCategory: r.categoryAtStart,
    statusName: names.get(r.transitionId) ?? r.categoryAtStart,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    endReason: r.endReason,
    durationSeconds: r.endedAt ? (r.durationSeconds ?? durationSeconds(r.startedAt, r.endedAt, now)) : durationSeconds(r.startedAt, null, now),
    isRunning: r.endedAt === null,
    note: r.note,
  }));
}

/** Sessions on a job the actor may see (all with `timer.view_others`, else their own), newest first. */
async function visibleSessions(db: DbLike, ctx: AuthContext, jobId: string): Promise<WorkSession[]> {
  const { job, ref } = await loadJobWithRef(db, ctx, jobId);
  assertCan(ctx, "job.view", ref);
  const seeAll = can(ctx, "timer.view_others", ref);
  if (!seeAll && !ctx.userId) return [];
  return db
    .select()
    .from(workSessions)
    .where(
      and(
        eq(workSessions.organisationId, ctx.organisationId),
        eq(workSessions.jobId, job.id),
        seeAll || !ctx.userId ? undefined : eq(workSessions.userId, ctx.userId),
      ),
    )
    .orderBy(desc(workSessions.startedAt), desc(workSessions.id));
}

/** The job's Time tab: sessions newest first (others' only with `timer.view_others`). */
export async function listSessions(db: DbLike, ctx: AuthContext, jobId: string): Promise<WorkSessionView[]> {
  return toViews(db, ctx, await visibleSessions(db, ctx, jobId));
}

/**
 * `userId`'s running timer with its job (default: the actor). Another
 * user's timer requires owner/manager. Null when none is running.
 */
export async function runningSessionFor(
  db: DbLike,
  ctx: AuthContext,
  userId: string | null = ctx.userId,
): Promise<RunningSessionView | null> {
  if (!userId) return null;
  if (userId !== ctx.userId && !isManagement(ctx) && !ctx.isSystem) throw new ForbiddenError("timer.view_others");
  const running = await runningForUser(db, ctx.organisationId, userId);
  if (!running) return null;
  const job = await jobLabel(db, ctx, running.jobId);
  if (!job) return null;
  const [view] = await toViews(db, ctx, [running]);
  return { ...view, job: { id: job.id, jobNumber: job.jobNumber, name: job.name } };
}

/** Totals for a job's visible sessions; running sessions count up to now. */
export async function sessionTotals(db: DbLike, ctx: AuthContext, jobId: string): Promise<SessionTotals> {
  const views = await toViews(db, ctx, await visibleSessions(db, ctx, jobId));

  const byUser = new Map<string, { user: WorkSessionView["user"]; seconds: number }>();
  const byCategory: Partial<Record<StatusCategory, number>> = {};
  let totalSeconds = 0;
  let runningCount = 0;
  for (const v of views) {
    totalSeconds += v.durationSeconds;
    if (v.isRunning) runningCount += 1;
    const entry = byUser.get(v.user.id) ?? { user: v.user, seconds: 0 };
    entry.seconds += v.durationSeconds;
    byUser.set(v.user.id, entry);
    byCategory[v.statusCategory] = (byCategory[v.statusCategory] ?? 0) + v.durationSeconds;
  }
  return {
    totalSeconds,
    runningCount,
    byUser: Array.from(byUser.values()).sort((a, b) => b.seconds - a.seconds),
    byCategory,
  };
}
