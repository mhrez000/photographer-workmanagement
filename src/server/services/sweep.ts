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
 *      this dueDate, so a deadline change re-arms it. Then the daily late
 *      summary (SIMPLIFICATION-PLAN §8): ONE `job_overdue` notice per person
 *      (editor, photographer, admins) per civil day listing every late job
 *      (dedupe `late_summary:<userId>:<civilDate>`); `job_overdue`
 *      automations are enqueued by recordEvent.
 *   3. `job.review_overdue` for REVIEWER_HOLDS jobs past `review_due_date`,
 *      one per (job, reviewDueDate); notifies photographer + admins.
 *   4. workload bands of active editors: `user.workload_band_changed` only
 *      when the band differs from the latest such event (no event yet =
 *      healthy); entering near_capacity / overloaded notifies the workload
 *      watchers = admins ∪ team members with "View team workload"
 *      (`workload_threshold`, dedupe per editor/band/civil day; no job
 *      details) and fires `workload_threshold` automations.
 *   5. `editor_unavailable` for active jobs held by a deactivated editor:
 *      admins get every job; each team member with "View team workload" gets
 *      only the jobs they can see (nothing when none) — docs/ROLES.md §6.2
 *      (dedupe per editor per civil day; notification only).
 *   6. auto-close work sessions running longer than
 *      `work_session_auto_timeout_minutes` (`auto_timeout`).
 *   7. execute the automation runs enqueued above.
 *
 * `last_overdue_sweep_at` is an audit exemption (no event, no version bump).
 */
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import { getDb, type Db, type DbLike, type Tx } from "@/db/index";
import { activityEvents, jobs, organisationSettings, users, type Json } from "@/db/schema";
import {
  CATEGORY_GROUPS,
  LATE_SUMMARY_LINK_PATH,
  SWEEP_MIN_INTERVAL_MINUTES,
  WORKLOAD_BANDS,
  WORKLOAD_BAND_META,
  lateSummaryDedupeKey,
  type WorkloadBand,
} from "@/lib/constants";
import { loadJobRefs } from "@/server/auth/job-ref";
import { formatDateShort, todayCivil } from "@/lib/dates";
import type { AuthContext, Job } from "@/lib/types";
import { recordEvent } from "@/server/audit";
import { assertCan, can } from "@/server/auth/permissions";
import { buildContextFromDb, systemContext } from "@/server/auth/session";
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
import { adminsOf, notify } from "./notifications";
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
export async function latestFlagValues(
  db: DbLike,
  organisationId: string,
  eventType: "job.became_overdue" | "job.review_overdue" | "user.workload_band_changed",
  ids: readonly string[],
  key: string,
  by: "job" | "entity" = "job",
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const column = by === "job" ? activityEvents.jobId : activityEvents.entityId;
  for (const part of chunks(Array.from(new Set(ids)))) {
    const rows = await db
      .select({ ref: column, newValue: activityEvents.newValue })
      .from(activityEvents)
      .where(and(eq(activityEvents.organisationId, organisationId), eq(activityEvents.eventType, eventType), inArray(column, part)))
      .orderBy(asc(activityEvents.createdAt), asc(activityEvents.rowid));
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

/**
 * Step 2 — `job.became_overdue`, deduped per (job, dueDate) exactly as before (the event is what
 * metrics, bottlenecks and `job_overdue` automations key on), then the SIMPLIFICATION-PLAN §8 late
 * notice: ONE `job_overdue` notification per person per civil day ("3 jobs are late"), covering every
 * late job they hold (editor), shot (photographer) or oversee (admins) — never one per job. Dedupe key
 * `late_summary:<userId>:<civilDate>`. A single late job links to that job (and to its new
 * became-overdue event, so a `job_overdue` rule never double-notifies the same person).
 * Returns the NEWLY flagged job ids.
 */
export async function flagOverdueJobs(tx: Tx, ctx: AuthContext): Promise<string[]> {
  const now = ctx.now();
  const candidates = await tx
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
    .orderBy(asc(jobs.dueDate), asc(jobs.jobNumber));
  if (candidates.length === 0) return [];
  const flagged = await latestFlagValues(tx, ctx.organisationId, "job.became_overdue", candidates.map((j) => j.id), "dueDate");
  const out: string[] = [];
  const newEventByJob = new Map<string, string>();
  for (const job of candidates) {
    const dueDate = job.dueDate as string;
    if (flagged.get(job.id) === dueDate) continue;
    const eventId = await recordEvent(tx, ctx, {
      entityType: "job",
      entityId: job.id,
      jobId: job.id,
      eventType: "job.became_overdue",
      action: "flagged",
      previousValue: null,
      newValue: { dueDate, overdueSince: dueDate },
      metadata: jobEventMeta(job, { statusCategory: job.statusCategory }),
    });
    newEventByJob.set(job.id, eventId);
    out.push(job.id);
  }
  await sendLateSummaries(tx, ctx, candidates, newEventByJob);
  return out;
}

/** The daily late summary (plan §8 notification 7): one notice per person per civil day. */
async function sendLateSummaries(tx: Tx, ctx: AuthContext, late: readonly Job[], newEventByJob: ReadonlyMap<string, string>): Promise<void> {
  if (late.length === 0) return;
  const tz = ctx.settings.timezone;
  const today = todayCivil(tz, new Date(ctx.now()));
  const admins = await adminsOf(tx, ctx.organisationId);
  const perUser = new Map<string, Job[]>();
  const add = (userId: string | null, job: Job) => {
    if (!userId) return;
    const list = perUser.get(userId) ?? [];
    if (!list.some((j) => j.id === job.id)) list.push(job);
    perUser.set(userId, list);
  };
  for (const job of late) {
    add(job.editorId, job);
    add(job.photographerId, job);
    for (const admin of admins) add(admin, job);
  }
  for (const [userId, mine] of perUser) {
    const n = mine.length;
    const names = mine.slice(0, 3).map((j) => j.name);
    const body = `${names.join(" · ")}${n > 3 ? ` · and ${n - 3} more` : ""}`;
    const single = n === 1 ? mine[0] : null;
    await notify(tx, ctx, {
      userIds: [userId],
      type: "job_overdue",
      title: n === 1 ? "1 job is late" : `${n} jobs are late`,
      body: single ? `${single.name} — was due ${formatDateShort(single.dueDate, tz)}` : body,
      jobId: single?.id ?? null,
      activityEventId: single ? (newEventByJob.get(single.id) ?? null) : null,
      linkPath: single ? jobLinkPath(single.id) : LATE_SUMMARY_LINK_PATH,
      dedupeKey: lateSummaryDedupeKey(userId, today),
    });
  }
}

/**
 * Workload watchers (docs/ROLES.md §6.2): active admins ∪ active team members
 * with "View team workload". Only for notifications WITHOUT job details.
 */
export async function workloadWatchersOf(db: DbLike, organisationId: string): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.organisationId, organisationId),
        eq(users.isActive, true),
        eq(users.role, "photographer"),
        or(eq(users.isAdmin, true), eq(users.canViewTeamWorkloads, true)),
      ),
    )
    .orderBy(asc(users.id));
  return rows.map((r) => r.id);
}

/** Active team members (non-admin photographers) with "View team workload". */
async function memberWatchersOf(db: DbLike, organisationId: string): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.organisationId, organisationId),
        eq(users.isActive, true),
        eq(users.role, "photographer"),
        eq(users.isAdmin, false),
        eq(users.canViewTeamWorkloads, true),
      ),
    )
    .orderBy(asc(users.id));
  return rows.map((r) => r.id);
}

/** Step 3 — `job.review_overdue`, deduped per (job, reviewDueDate). */
export async function flagReviewOverdueJobs(tx: Tx, ctx: AuthContext): Promise<string[]> {
  const now = ctx.now();
  const candidates: Job[] = await tx
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
    .orderBy(asc(jobs.reviewDueDate), asc(jobs.jobNumber));
  if (candidates.length === 0) return [];
  const flagged = await latestFlagValues(tx, ctx.organisationId, "job.review_overdue", candidates.map((j) => j.id), "reviewDueDate");
  const admins = await adminsOf(tx, ctx.organisationId);
  const out: string[] = [];
  for (const job of candidates) {
    const reviewDueDate = job.reviewDueDate as string;
    if (flagged.get(job.id) === reviewDueDate) continue;
    const eventId = await recordEvent(tx, ctx, {
      entityType: "job",
      entityId: job.id,
      jobId: job.id,
      eventType: "job.review_overdue",
      action: "flagged",
      previousValue: null,
      newValue: { reviewDueDate },
      metadata: jobEventMeta(job, { statusCategory: job.statusCategory }),
    });
    await notify(tx, ctx, {
      userIds: [job.photographerId, ...admins],
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
export async function evaluateWorkloadBands(tx: Tx, ctx: AuthContext): Promise<SweepResult["bandChanges"]> {
  const now = ctx.now();
  const rows = (await computeWorkloads(tx, ctx, { now })).rows.filter((r) => r.editor.isActive);
  if (rows.length === 0) return [];
  const latest = await latestFlagValues(tx, ctx.organisationId, "user.workload_band_changed", rows.map((r) => r.editor.id), "band", "entity");
  const today = todayCivil(ctx.settings.timezone, new Date(now));
  let watchers: string[] | null = null;
  const changes: SweepResult["bandChanges"] = [];
  for (const row of rows) {
    const stored = latest.get(row.editor.id);
    const previous: WorkloadBand = isBand(stored) ? stored : "healthy";
    if (previous === row.band) continue;
    const eventId = await recordEvent(tx, ctx, {
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
      watchers ??= await workloadWatchersOf(tx, ctx.organisationId);
      await notify(tx, ctx, {
        userIds: watchers,
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

/**
 * Step 5 — active jobs held by deactivated editors → `editor_unavailable`:
 * admins (every job), plus each member with "View team workload" for the jobs
 * they can see (docs/ROLES.md §6.2; omitted when they can see none).
 */
export async function notifyEditorUnavailable(tx: Tx, ctx: AuthContext): Promise<SweepResult["editorUnavailable"]> {
  const rows = await tx
    .select({ jobId: jobs.id, editorId: users.id, name: users.name })
    .from(jobs)
    .innerJoin(users, eq(users.id, jobs.editorId))
    .where(and(eq(jobs.organisationId, ctx.organisationId), inArray(jobs.statusCategory, [...CATEGORY_GROUPS.ACTIVE]), eq(users.isActive, false)))
    .orderBy(asc(users.name), asc(users.id), asc(jobs.jobNumber));
  if (rows.length === 0) return [];
  const byEditor = new Map<string, { name: string; jobIds: string[] }>();
  for (const r of rows) {
    const entry = byEditor.get(r.editorId) ?? { name: r.name, jobIds: [] };
    entry.jobIds.push(r.jobId);
    byEditor.set(r.editorId, entry);
  }
  const admins = await adminsOf(tx, ctx.organisationId);
  const memberContexts: AuthContext[] = [];
  for (const id of await memberWatchersOf(tx, ctx.organisationId)) {
    const member = await buildContextFromDb(tx, id, { now: ctx.now, requestId: ctx.requestId });
    if (member && member.organisationId === ctx.organisationId) memberContexts.push(member);
  }
  const refs = memberContexts.length > 0 ? await loadJobRefs(tx, ctx, rows.map((r) => r.jobId)) : new Map();
  const today = todayCivil(ctx.settings.timezone, new Date(ctx.now()));
  const out: SweepResult["editorUnavailable"] = [];
  const message = (name: string, n: number) => ({
    title: `${n} job${n === 1 ? "" : "s"} assigned to a deactivated editor`,
    body: `${name} is deactivated but still holds ${n} active job${n === 1 ? "" : "s"}. Reassign them.`,
  });
  for (const [editorId, entry] of byEditor) {
    const sent = await notify(tx, ctx, {
      userIds: admins,
      type: "editor_unavailable",
      ...message(entry.name, entry.jobIds.length),
      jobId: null,
      activityEventId: null,
      linkPath: "/team/workloads",
      dedupeKey: `unavailable:${editorId}:${today}`,
    });
    let notified = sent.recipientIds.length;
    for (const member of memberContexts) {
      const visible = entry.jobIds.filter((jobId) => {
        const loaded = refs.get(jobId);
        return loaded !== undefined && can(member, "job.view", loaded.ref);
      });
      if (visible.length === 0) continue;
      const res = await notify(tx, ctx, {
        userIds: [member.userId],
        type: "editor_unavailable",
        ...message(entry.name, visible.length),
        jobId: null,
        activityEventId: null,
        linkPath: "/team/workloads",
        dedupeKey: `unavailable:${editorId}:${today}`,
      });
      notified += res.recipientIds.length;
    }
    out.push({ editorId, jobIds: entry.jobIds, notified });
  }
  return out;
}

/** Step 6 — auto-close timers past the org timeout. */
export async function closeStaleSessions(tx: Tx, ctx: AuthContext): Promise<string[]> {
  return (await closeTimedOutSessions(tx, ctx)).map((s) => s.id);
}

/* ------------------------------------------------------------------ */
/*  Entry points                                                       */
/* ------------------------------------------------------------------ */

async function stampSweep(tx: Tx, organisationId: string, at: string): Promise<void> {
  await tx.update(organisationSettings).set({ lastOverdueSweepAt: at }).where(eq(organisationSettings.organisationId, organisationId));
}

/**
 * Runs the full sweep for an organisation. `target` = the caller's context
 * (human callers need `system.sweep`; system contexts pass) or an org id
 * (trusted server code: layout, seed, scheduler glue). Never throws for a
 * failing step — see `errors` — but does throw ForbiddenError for a human
 * without `system.sweep`.
 */
export async function runSweep(db: Db, target: AuthContext | string, opts: RunSweepOptions = {}): Promise<SweepResult> {
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

  // Steps run one after another (each awaited): one failing step never blocks the others.
  const step = async <T>(name: SweepStep, fn: () => Promise<T>, apply: (value: T) => void): Promise<void> => {
    try {
      apply(await fn());
    } catch (err) {
      result.errors.push({ step: name, message: errorMessage(err) });
    }
  };
  const inTx =
    <T>(fn: (tx: Tx, ctx: AuthContext) => Promise<T>) =>
    () =>
      withTx(async (tx) => fn(tx, await systemContext(organisationId, { db: tx, cause: "sweep", requestId })), { db });

  await step("replay", () => replayStalePendingRuns(db, organisationId, PENDING_REPLAY_AGE_SECONDS), (v) => (result.replayed = v));
  await step(
    "overdue",
    inTx(async (tx, ctx) => {
      await stampSweep(tx, organisationId, ctx.now());
      return flagOverdueJobs(tx, ctx);
    }),
    (v) => (result.overdueJobIds = v),
  );
  await step("review_overdue", inTx(flagReviewOverdueJobs), (v) => (result.reviewOverdueJobIds = v));
  await step("workload_bands", inTx(evaluateWorkloadBands), (v) => (result.bandChanges = v));
  await step("editor_unavailable", inTx(notifyEditorUnavailable), (v) => (result.editorUnavailable = v));
  await step("session_timeouts", inTx(closeStaleSessions), (v) => (result.timedOutSessionIds = v));
  await step("automations", () => runPendingAutomations(db, organisationId, { requestId }), (v) => (result.automations = v));
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
export async function maybeRunSweep(db: Db, organisationId: string, opts: RunSweepOptions = {}): Promise<SweepResult | null> {
  const now = nowIso();
  const cutoff = new Date(Date.parse(now) - SWEEP_MIN_INTERVAL_MINUTES * 60_000).toISOString();
  const claimed = await withTx(
    async (tx) =>
      (
        await tx
          .update(organisationSettings)
          .set({ lastOverdueSweepAt: now })
          .where(
            and(
              eq(organisationSettings.organisationId, organisationId),
              or(isNull(organisationSettings.lastOverdueSweepAt), lte(organisationSettings.lastOverdueSweepAt, cutoff)),
            ),
          )
          .returning({ id: organisationSettings.organisationId })
      ).length,
    { db },
  );
  if (claimed === 0) return null;
  return runSweep(db, organisationId, opts);
}

/**
 * `maybeRunSweep` on the app database for the app layout (run via `after()`):
 * swallows every error so a sweep problem can never break a page.
 */
export async function lazySweep(organisationId: string): Promise<SweepResult | null> {
  try {
    return await maybeRunSweep(getDb(), organisationId);
  } catch (err) {
    console.warn("[sweep] lazy sweep failed", err instanceof Error ? err.message : err);
    return null;
  }
}
