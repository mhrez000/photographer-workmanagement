/**
 * The sweep (ARCHITECTURE.md §8 "Sweep", §5 `job.became_overdue` /
 * `job.review_overdue` / `user.workload_band_changed`, §6 recipients).
 *
 * There is no cron: the sweep runs lazily from the app layout
 * (`maybeRunSweep`, at most once per SWEEP_MIN_INTERVAL_MINUTES per org,
 * claimed atomically on `organisation_settings.last_overdue_sweep_at`) and
 * on demand via `POST /api/system/sweep` (`system.sweep`, which an external
 * scheduler may also call). Steps, each in its own transaction with the
 * system context (`metadata.cause = "sweep"`) so one failing step never
 * blocks the others:
 *
 *   1. replay pending automation runs older than 60 s (lost after commit)
 *   2. `job.became_overdue` for DEADLINE_BOUND jobs past `due_date`, one per
 *      (job, dueDate): skipped when the job's latest such event already has
 *      this dueDate, so a deadline change re-arms it. Notifies editor +
 *      photographer (`job_overdue`, dedupe `overdue:<jobId>:<dueDate>`);
 *      `job_overdue` automations are enqueued by recordEvent.
 *   3. `job.review_overdue` for REVIEWER_HOLDS jobs past `review_due_date`,
 *      one per (job, reviewDueDate); notifies photographer + managers.
 *   4. workload bands of active editors: `user.workload_band_changed` only
 *      when the band differs from the latest such event (no event yet =
 *      healthy); entering near_capacity / overloaded notifies managers +
 *      owners (`workload_threshold`, dedupe per editor/band/civil day) and
 *      fires `workload_threshold` automations.
 *   5. `editor_unavailable` to managers for active jobs held by a deactivated
 *      editor (dedupe per editor per civil day; notification only).
 *   6. auto-close work sessions running longer than
 *      `work_session_auto_timeout_minutes` (`auto_timeout`).
 *   7. execute the automation runs enqueued above.
 *
 * `last_overdue_sweep_at` is an audit exemption (no event, no version bump).
 */
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { getDb, type Db, type DbLike, type Tx } from "@/db/index";
import { activityEvents, jobs, organisationSettings, users, type Json } from "@/db/schema";
import { CATEGORY_GROUPS, SWEEP_MIN_INTERVAL_MINUTES, WORKLOAD_BANDS, WORKLOAD_BAND_META, type WorkloadBand } from "@/lib/constants";
import { formatDateShort, todayCivil } from "@/lib/dates";
import type { AuthContext, Job } from "@/lib/types";
import { recordEvent } from "@/server/audit";
import { assertCan } from "@/server/auth/permissions";
import { systemContext } from "@/server/auth/session";
import { nowIso } from "@/server/clock";
import { computeWorkloads } from "@/server/queries/workloads";
import { withTx } from "./_shared";
import {
  PENDING_REPLAY_AGE_SECONDS,
  emptyRunPendingResult,
  errorMessage,
  replayStalePendingRuns,
  runPendingAutomations,
  type RunPendingResult,
} from "./automationEngine";
import { managersOf, notify } from "./notifications";
import { closeTimedOutSessions } from "./timeTracking";
import { jobEventMeta, jobLinkPath } from "./workflow";

export type SweepStep = "replay" | "overdue" | "review_overdue" | "workload_bands" | "editor_unavailable" | "session_timeouts" | "automations";

export interface SweepResult {
  organisationId: string;
  ranAt: string;
  /** Jobs that got a `job.became_overdue` event in this sweep. */
  overdueJobIds: string[];
  /** Jobs that got a `job.review_overdue` event in this sweep. */
  reviewOverdueJobIds: string[];
  bandChanges: { userId: string; from: WorkloadBand; to: WorkloadBand }[];
  /** Deactivated editors still holding active jobs (notified once per civil day). */
  editorUnavailable: { editorId: string; jobIds: string[]; notified: number }[];
  timedOutSessionIds: string[];
  /** Stale pending runs replayed (step 1). */
  replayed: RunPendingResult;
  /** Runs executed at the end (step 7). */
  automations: RunPendingResult;
  /** Steps that failed (the others still ran). */
  errors: { step: SweepStep; message: string }[];
}

export interface RunSweepOptions {
  requestId?: string;
}

const CHUNK = 400;

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function bag(value: Json | null | undefined): Record<string, Json> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * `newValue[key]` of the LATEST event of `eventType` per job (or per entity
 * when `by = "entity"`), in insertion order. Missing → absent from the map.
 */
export function latestFlagValues(
  db: DbLike,
  organisationId: string,
  eventType: "job.became_overdue" | "job.review_overdue" | "user.workload_band_changed",
  ids: readonly string[],
  key: string,
  by: "job" | "entity" = "job",
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const column = by === "job" ? activityEvents.jobId : activityEvents.entityId;
  for (const part of chunks(Array.from(new Set(ids)))) {
    const rows = db
      .select({ ref: column, newValue: activityEvents.newValue })
      .from(activityEvents)
      .where(and(eq(activityEvents.organisationId, organisationId), eq(activityEvents.eventType, eventType), inArray(column, part)))
      .orderBy(asc(activityEvents.createdAt), asc(sql`rowid`))
      .all();
    for (const row of rows) {
      if (!row.ref) continue;
      const value = bag(row.newValue)[key];
      out.set(row.ref, typeof value === "string" ? value : null);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Steps (each runs in its own transaction with the system context)   */
/* ------------------------------------------------------------------ */

/** Step 2 — `job.became_overdue`, deduped per (job, dueDate). Returns the flagged job ids. */
export function flagOverdueJobs(tx: Tx, ctx: AuthContext): string[] {
  const now = ctx.now();
  const candidates = tx
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.organisationId, ctx.organisationId),
        inArray(jobs.statusCategory, [...CATEGORY_GROUPS.DEADLINE_BOUND]),
        isNotNull(jobs.dueDate),
        lt(jobs.dueDate, now),
      ),
    )
    .orderBy(asc(jobs.dueDate), asc(jobs.jobNumber))
    .all();
  if (candidates.length === 0) return [];
  const flagged = latestFlagValues(tx, ctx.organisationId, "job.became_overdue", candidates.map((j) => j.id), "dueDate");
  const out: string[] = [];
  for (const job of candidates) {
    const dueDate = job.dueDate as string;
    if (flagged.get(job.id) === dueDate) continue;
    const eventId = recordEvent(tx, ctx, {
      entityType: "job",
      entityId: job.id,
      jobId: job.id,
      eventType: "job.became_overdue",
      action: "flagged",
      previousValue: null,
      newValue: { dueDate, overdueSince: dueDate },
      metadata: jobEventMeta(job, { statusCategory: job.statusCategory }),
    });
    notify(tx, ctx, {
      userIds: [job.editorId, job.photographerId],
      type: "job_overdue",
      title: `${job.jobNumber} is overdue`,
      body: `${job.name} — was due ${formatDateShort(dueDate, ctx.settings.timezone)}`,
      jobId: job.id,
      activityEventId: eventId,
      linkPath: jobLinkPath(job.id),
      dedupeKey: `overdue:${job.id}:${dueDate}`,
    });
    out.push(job.id);
  }
  return out;
}

/** Step 3 — `job.review_overdue`, deduped per (job, reviewDueDate). */
export function flagReviewOverdueJobs(tx: Tx, ctx: AuthContext): string[] {
  const now = ctx.now();
  const candidates: Job[] = tx
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.organisationId, ctx.organisationId),
        inArray(jobs.statusCategory, [...CATEGORY_GROUPS.REVIEWER_HOLDS]),
        isNotNull(jobs.reviewDueDate),
        lt(jobs.reviewDueDate, now),
      ),
    )
    .orderBy(asc(jobs.reviewDueDate), asc(jobs.jobNumber))
    .all();
  if (candidates.length === 0) return [];
  const flagged = latestFlagValues(tx, ctx.organisationId, "job.review_overdue", candidates.map((j) => j.id), "reviewDueDate");
  const managers = managersOf(tx, ctx.organisationId);
  const out: string[] = [];
  for (const job of candidates) {
    const reviewDueDate = job.reviewDueDate as string;
    if (flagged.get(job.id) === reviewDueDate) continue;
    const eventId = recordEvent(tx, ctx, {
      entityType: "job",
      entityId: job.id,
      jobId: job.id,
      eventType: "job.review_overdue",
      action: "flagged",
      previousValue: null,
      newValue: { reviewDueDate },
      metadata: jobEventMeta(job, { statusCategory: job.statusCategory }),
    });
    notify(tx, ctx, {
      userIds: [job.photographerId, ...managers],
      type: "review_overdue",
      title: `Review of ${job.jobNumber} is overdue`,
      body: `${job.name} — review was due ${formatDateShort(reviewDueDate, ctx.settings.timezone)}`,
      jobId: job.id,
      activityEventId: eventId,
      linkPath: jobLinkPath(job.id),
      dedupeKey: `review_overdue:${job.id}:${reviewDueDate}`,
    });
    out.push(job.id);
  }
  return out;
}

function isBand(value: string | null | undefined): value is WorkloadBand {
  return typeof value === "string" && (WORKLOAD_BANDS as readonly string[]).includes(value);
}

/** Step 4 — workload band changes of active editors (emitted only on change). */
export function evaluateWorkloadBands(tx: Tx, ctx: AuthContext): SweepResult["bandChanges"] {
  const now = ctx.now();
  const rows = computeWorkloads(tx, ctx, { now }).rows.filter((r) => r.editor.isActive);
  if (rows.length === 0) return [];
  const latest = latestFlagValues(tx, ctx.organisationId, "user.workload_band_changed", rows.map((r) => r.editor.id), "band", "entity");
  const today = todayCivil(ctx.settings.timezone, new Date(now));
  let managers: string[] | null = null;
  const changes: SweepResult["bandChanges"] = [];
  for (const row of rows) {
    const stored = latest.get(row.editor.id);
    const previous: WorkloadBand = isBand(stored) ? stored : "healthy";
    if (previous === row.band) continue;
    const eventId = recordEvent(tx, ctx, {
      entityType: "user",
      entityId: row.editor.id,
      jobId: null,
      eventType: "user.workload_band_changed",
      action: "flagged",
      previousValue: { band: previous },
      newValue: { band: row.band, score: round2(row.score), ratio: round2(row.ratio), active: row.active },
      metadata: { targetUserId: row.editor.id, targetName: row.editor.name, bandReason: row.bandReason },
    });
    if (row.band !== "healthy") {
      managers ??= managersOf(tx, ctx.organisationId);
      notify(tx, ctx, {
        userIds: managers,
        type: "workload_threshold",
        title: `${row.editor.name} is ${WORKLOAD_BAND_META[row.band].label.toLowerCase()}`,
        body: `${row.active} active job${row.active === 1 ? "" : "s"}, ${Math.round(row.ratio * 100)}% of weekly capacity${row.overdue ? `, ${row.overdue} overdue` : ""}`,
        jobId: null,
        activityEventId: eventId,
        linkPath: `/team/users/${row.editor.id}`,
        dedupeKey: `workload:${row.editor.id}:${row.band}:${today}`,
      });
    }
    changes.push({ userId: row.editor.id, from: previous, to: row.band });
  }
  return changes;
}

/** Step 5 — active jobs held by deactivated editors → managers (`editor_unavailable`). */
export function notifyEditorUnavailable(tx: Tx, ctx: AuthContext): SweepResult["editorUnavailable"] {
  const rows = tx
    .select({ jobId: jobs.id, editorId: users.id, name: users.name })
    .from(jobs)
    .innerJoin(users, eq(users.id, jobs.editorId))
    .where(and(eq(jobs.organisationId, ctx.organisationId), inArray(jobs.statusCategory, [...CATEGORY_GROUPS.ACTIVE]), eq(users.isActive, false)))
    .orderBy(asc(users.name), asc(jobs.jobNumber))
    .all();
  if (rows.length === 0) return [];
  const byEditor = new Map<string, { name: string; jobIds: string[] }>();
  for (const r of rows) {
    const entry = byEditor.get(r.editorId) ?? { name: r.name, jobIds: [] };
    entry.jobIds.push(r.jobId);
    byEditor.set(r.editorId, entry);
  }
  const managers = managersOf(tx, ctx.organisationId);
  const today = todayCivil(ctx.settings.timezone, new Date(ctx.now()));
  const out: SweepResult["editorUnavailable"] = [];
  for (const [editorId, entry] of byEditor) {
    const n = entry.jobIds.length;
    const sent = notify(tx, ctx, {
      userIds: managers,
      type: "editor_unavailable",
      title: `${n} job${n === 1 ? "" : "s"} assigned to a deactivated editor`,
      body: `${entry.name} is deactivated but still holds ${n} active job${n === 1 ? "" : "s"}. Reassign them.`,
      jobId: null,
      activityEventId: null,
      linkPath: "/team/workloads",
      dedupeKey: `unavailable:${editorId}:${today}`,
    });
    out.push({ editorId, jobIds: entry.jobIds, notified: sent.recipientIds.length });
  }
  return out;
}

/** Step 6 — auto-close timers past the org timeout. */
export function closeStaleSessions(tx: Tx, ctx: AuthContext): string[] {
  return closeTimedOutSessions(tx, ctx).map((s) => s.id);
}

/* ------------------------------------------------------------------ */
/*  Entry points                                                       */
/* ------------------------------------------------------------------ */

function stampSweep(tx: Tx, organisationId: string, at: string): void {
  tx.update(organisationSettings).set({ lastOverdueSweepAt: at }).where(eq(organisationSettings.organisationId, organisationId)).run();
}

/**
 * Runs the full sweep for an organisation. `target` = the caller's context
 * (human callers need `system.sweep`; system contexts pass) or an org id
 * (trusted server code: layout, seed, scheduler glue). Never throws for a
 * failing step — see `errors` — but does throw ForbiddenError for a human
 * without `system.sweep`.
 */
export function runSweep(db: Db, target: AuthContext | string, opts: RunSweepOptions = {}): SweepResult {
  const organisationId = typeof target === "string" ? target : target.organisationId;
  if (typeof target !== "string" && !target.isSystem) assertCan(target, "system.sweep");
  const requestId = opts.requestId ?? (typeof target === "string" ? undefined : target.requestId);
  const ranAt = nowIso();
  const result: SweepResult = {
    organisationId,
    ranAt,
    overdueJobIds: [],
    reviewOverdueJobIds: [],
    bandChanges: [],
    editorUnavailable: [],
    timedOutSessionIds: [],
    replayed: emptyRunPendingResult(),
    automations: emptyRunPendingResult(),
    errors: [],
  };

  const step = <T>(name: SweepStep, fn: () => T, apply: (value: T) => void): void => {
    try {
      apply(fn());
    } catch (err) {
      result.errors.push({ step: name, message: errorMessage(err) });
    }
  };
  const inTx = <T>(fn: (tx: Tx, ctx: AuthContext) => T) => () =>
    withTx((tx) => fn(tx, systemContext(organisationId, { db: tx, cause: "sweep", requestId })), { db });

  step("replay", () => replayStalePendingRuns(db, organisationId, PENDING_REPLAY_AGE_SECONDS), (v) => (result.replayed = v));
  step(
    "overdue",
    inTx((tx, ctx) => {
      stampSweep(tx, organisationId, ctx.now());
      return flagOverdueJobs(tx, ctx);
    }),
    (v) => (result.overdueJobIds = v),
  );
  step("review_overdue", inTx(flagReviewOverdueJobs), (v) => (result.reviewOverdueJobIds = v));
  step("workload_bands", inTx(evaluateWorkloadBands), (v) => (result.bandChanges = v));
  step("editor_unavailable", inTx(notifyEditorUnavailable), (v) => (result.editorUnavailable = v));
  step("session_timeouts", inTx(closeStaleSessions), (v) => (result.timedOutSessionIds = v));
  step("automations", () => runPendingAutomations(db, organisationId, { requestId }), (v) => (result.automations = v));
  return result;
}

/** True when a sweep last run at `lastSweepAt` is old enough to run again at `now`. */
export function sweepIsDue(lastSweepAt: string | null, now: string, minIntervalMinutes = SWEEP_MIN_INTERVAL_MINUTES): boolean {
  if (!lastSweepAt) return true;
  return Date.parse(now) - Date.parse(lastSweepAt) >= minIntervalMinutes * 60_000;
}

/**
 * Lazy sweep (app layout): runs only when `last_overdue_sweep_at` is older
 * than SWEEP_MIN_INTERVAL_MINUTES. The claim is one conditional UPDATE, so
 * concurrent requests run at most one sweep. Returns null when not due.
 */
export function maybeRunSweep(db: Db, organisationId: string, opts: RunSweepOptions = {}): SweepResult | null {
  const now = nowIso();
  const cutoff = new Date(Date.parse(now) - SWEEP_MIN_INTERVAL_MINUTES * 60_000).toISOString();
  const claimed = withTx(
    (tx) =>
      tx
        .update(organisationSettings)
        .set({ lastOverdueSweepAt: now })
        .where(
          and(
            eq(organisationSettings.organisationId, organisationId),
            or(isNull(organisationSettings.lastOverdueSweepAt), lte(organisationSettings.lastOverdueSweepAt, cutoff)),
          ),
        )
        .run().changes,
    { db },
  );
  if (claimed === 0) return null;
  return runSweep(db, organisationId, opts);
}

/**
 * `maybeRunSweep` on the app database for the app layout (run via `after()`):
 * swallows every error so a sweep problem can never break a page.
 */
export function lazySweep(organisationId: string): SweepResult | null {
  try {
    return maybeRunSweep(getDb(), organisationId);
  } catch (err) {
    console.warn("[sweep] lazy sweep failed", err instanceof Error ? err.message : err);
    return null;
  }
}
