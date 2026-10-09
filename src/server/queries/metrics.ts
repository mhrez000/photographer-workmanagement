/**
 * SQL feeders for the pure metric formulas in `src/lib/metrics.ts`
 * (ARCHITECTURE.md §8). Every function here is a read over `DbLike`,
 * organisation-scoped (or visibility-scoped via `visibleJobsWhere`), and
 * returns plain rows the pure functions consume. Nothing here writes.
 *
 * Shared by dashboard / workloads / performance / analytics / bottlenecks /
 * reports / directories so every page computes the same number the same way:
 *   - `completedJobsInRange()`  → the ONE "completed in range" (latest completion only)
 *   - `approvedJobsInRange()`   → approvals in range + approving editor (CTE-style subquery)
 *   - `loadTransitionsByJob()`  → time-in-stage ledgers for turnaround/editing/review
 *   - `revisionWeekWindows()`   → revision spike inputs
 *   - `jobCountsBy()`           → open / overdue / due today / completed per client/project/person
 */
import { and, asc, eq, gte, inArray, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "@/db/index";
import { activityEvents, jobRevisions, jobStatusTransitions, jobTypes, jobs, organisationSettings, users } from "@/db/schema";
import { BOTTLENECK_DEFAULTS, CATEGORY_GROUPS, DEFAULT_TIMEZONE, RANGE_PRESETS, STATUS_CATEGORIES, WORKLOAD_THRESHOLDS, type Priority, type StatusCategory } from "@/lib/constants";
import { addCivilDays, civilMonthRange, resolveRange, startOfCivilDayIso, todayCivil } from "@/lib/dates";
import { completedInRange, kpiSummary, type BottleneckSettings, type Range, type TransitionLike, type WorkloadSettings } from "@/lib/metrics";
import type { AuthContext, JobCounts, JobRef, KpiSummary, OrganisationSettings, ResolvedRange, StageAverage, UserRef } from "@/lib/types";
import { visibleJobsWhere } from "@/server/auth/permissions";
import { parseInput } from "@/server/services/_shared";
import { categoryIn, orgDayBounds } from "./scope";

const DAY_MS = 86_400_000;
const CHUNK = 500;

/* ------------------------------------------------------------------ */
/*  Small numeric helpers                                              */
/* ------------------------------------------------------------------ */

/** Arithmetic mean of the non-null values; null when there are none. */
export function mean(values: readonly (number | null | undefined)[]): number | null {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    sum += v;
    n += 1;
  }
  return n === 0 ? null : sum / n;
}

/** 0..1 rate → 0..100 percentage (null stays null). */
export function toPercent(rate: number | null): number | null {
  return rate === null ? null : rate * 100;
}

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const isoMinusDays = (iso: string, days: number): string => new Date(Date.parse(iso) - days * DAY_MS).toISOString();

/* ------------------------------------------------------------------ */
/*  Organisation settings                                              */
/* ------------------------------------------------------------------ */

/** organisation_settings row, or the column defaults when the row is missing. */
export function loadOrgSettings(db: DbLike, ctx: AuthContext): OrganisationSettings {
  const row = db.select().from(organisationSettings).where(eq(organisationSettings.organisationId, ctx.organisationId)).get();
  if (row) return row;
  return {
    organisationId: ctx.organisationId,
    timezone: ctx.settings.timezone ?? DEFAULT_TIMEZONE,
    weekStartsOn: 1,
    jobNumberPrefix: "PJ",
    timeTrackingEnabled: ctx.settings.timeTrackingEnabled,
    workSessionAutoTimeoutMinutes: 600,
    defaultCapacityHoursPerWeek: WORKLOAD_THRESHOLDS.defaultCapacityHoursPerWeek,
    defaultEstimatedHours: WORKLOAD_THRESHOLDS.defaultEstimatedHours,
    workloadNearCapacityRatio: WORKLOAD_THRESHOLDS.nearCapacityRatio,
    workloadOverloadedRatio: WORKLOAD_THRESHOLDS.overloadedRatio,
    maxActiveJobsPerEditor: WORKLOAD_THRESHOLDS.maxActiveJobsPerEditor,
    reviewBottleneckHours: BOTTLENECK_DEFAULTS.reviewBottleneckHours,
    reviewBottleneckMinJobs: BOTTLENECK_DEFAULTS.reviewBottleneckMinJobs,
    editingBottleneckDueWithinHours: BOTTLENECK_DEFAULTS.editingBottleneckDueWithinHours,
    editingBottleneckMinDueSoon: BOTTLENECK_DEFAULTS.editingBottleneckMinDueSoon,
    unassignedBacklogMin: BOTTLENECK_DEFAULTS.unassignedBacklogMin,
    stalledDays: BOTTLENECK_DEFAULTS.stalledDays,
    revisionSpikeMinCount: BOTTLENECK_DEFAULTS.revisionSpikeMinCount,
    revisionSpikeMultiplier: BOTTLENECK_DEFAULTS.revisionSpikeMultiplier,
    reviewSlaHours: BOTTLENECK_DEFAULTS.reviewSlaHours,
    photographersSeeAllJobs: ctx.settings.photographersSeeAllJobs,
    photographersSeeTeamJobs: ctx.settings.photographersSeeTeamJobs,
    editorsSeeTeamJobs: ctx.settings.editorsSeeTeamJobs,
    editorsSeeTeamWorkloads: ctx.settings.editorsSeeTeamWorkloads,
    automationsEnabled: ctx.settings.automationsEnabled,
    auditNotifications: ctx.settings.auditNotifications ?? false,
    lastOverdueSweepAt: null,
    updatedAt: ctx.now(),
    version: 1,
  };
}

export function workloadSettingsOf(s: OrganisationSettings): WorkloadSettings {
  return {
    defaultEstimatedHours: s.defaultEstimatedHours,
    defaultCapacityHoursPerWeek: s.defaultCapacityHoursPerWeek,
    workloadNearCapacityRatio: s.workloadNearCapacityRatio,
    workloadOverloadedRatio: s.workloadOverloadedRatio,
    maxActiveJobsPerEditor: s.maxActiveJobsPerEditor,
  };
}

export function bottleneckSettingsOf(s: OrganisationSettings): BottleneckSettings {
  return {
    reviewBottleneckHours: s.reviewBottleneckHours,
    reviewBottleneckMinJobs: s.reviewBottleneckMinJobs,
    editingBottleneckDueWithinHours: s.editingBottleneckDueWithinHours,
    editingBottleneckMinDueSoon: s.editingBottleneckMinDueSoon,
    unassignedBacklogMin: s.unassignedBacklogMin,
    stalledDays: s.stalledDays,
    revisionSpikeMinCount: s.revisionSpikeMinCount,
    revisionSpikeMultiplier: s.revisionSpikeMultiplier,
    maxActiveJobsPerEditor: s.maxActiveJobsPerEditor,
  };
}

/** job_types.default_estimated_hours by job type id (workload estHours fallback). */
export function loadJobTypeDefaultHours(db: DbLike, ctx: AuthContext): Record<string, number | null> {
  const rows = db
    .select({ id: jobTypes.id, hours: jobTypes.defaultEstimatedHours })
    .from(jobTypes)
    .where(eq(jobTypes.organisationId, ctx.organisationId))
    .all();
  const out: Record<string, number | null> = {};
  for (const r of rows) out[r.id] = r.hours;
  return out;
}

/* ------------------------------------------------------------------ */
/*  Ranges                                                             */
/* ------------------------------------------------------------------ */

const CIVIL = /^\d{4}-\d{2}-\d{2}$/;

/** `?range=<preset>&from=YYYY-MM-DD&to=YYYY-MM-DD` (also accepts `preset`). */
export const RangeInputSchema = z
  .object({
    range: z.enum(RANGE_PRESETS).optional(),
    preset: z.enum(RANGE_PRESETS).optional(),
    from: z.string().regex(CIVIL, "Use YYYY-MM-DD").optional(),
    to: z.string().regex(CIVIL, "Use YYYY-MM-DD").optional(),
  })
  .refine((v) => !(v.from && v.to) || v.from <= v.to, { message: "`from` must be on or before `to`", path: ["from"] });

/**
 * Resolves raw range input (query params / JSON) to ISO bounds in the org
 * timezone using the context clock. An already-resolved `ResolvedRange` is
 * passed through unchanged. Invalid input → ValidationError (400).
 */
export function resolveRangeInput(ctx: AuthContext, raw: unknown, fallback: ResolvedRange["preset"] = "last_30_days"): ResolvedRange {
  if (isResolvedRange(raw)) return raw;
  const input = parseInput(RangeInputSchema, raw ?? {});
  const preset = input.range ?? input.preset ?? (input.from || input.to ? "custom" : fallback);
  const r = resolveRange(preset, ctx.settings.timezone, { from: input.from ?? null, to: input.to ?? null }, new Date(ctx.now()));
  return { preset, from: r.from, to: r.to, label: r.label };
}

function isResolvedRange(raw: unknown): raw is ResolvedRange {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.from === "string" &&
    typeof r.to === "string" &&
    typeof r.label === "string" &&
    typeof r.preset === "string" &&
    !CIVIL.test(r.from) &&
    Number.isFinite(Date.parse(r.from)) &&
    Number.isFinite(Date.parse(r.to))
  );
}

/** Current civil month (org tz) as [from, to) instants. */
export function monthRangeAt(ctx: AuthContext, now: string): Range {
  const tz = ctx.settings.timezone;
  const [start, end] = civilMonthRange(todayCivil(tz, new Date(now)));
  return { from: startOfCivilDayIso(start, tz), to: startOfCivilDayIso(end, tz) };
}

/** Current week honouring organisation_settings.week_starts_on. */
export function weekRangeAt(ctx: AuthContext, now: string, weekStartsOn: number): Range {
  const b = orgDayBounds(ctx, now, weekStartsOn);
  return { from: b.weekStart, to: b.weekEnd };
}

/** The last `days` civil days including today: [start of (today − days + 1), start of tomorrow). */
export function lastDaysRange(ctx: AuthContext, now: string, days: number): Range {
  const tz = ctx.settings.timezone;
  const today = todayCivil(tz, new Date(now));
  return { from: startOfCivilDayIso(addCivilDays(today, -(days - 1)), tz), to: startOfCivilDayIso(addCivilDays(today, 1), tz) };
}

/* ------------------------------------------------------------------ */
/*  Metric job rows                                                    */
/* ------------------------------------------------------------------ */

/** The job columns metric formulas read (no joins). */
export interface MetricJob {
  id: string;
  jobNumber: string;
  name: string;
  organisationId: string;
  statusCategory: StatusCategory;
  statusEnteredAt: string;
  priority: Priority;
  dueDate: string | null;
  reviewDueDate: string | null;
  shootDate: string | null;
  isPaused: boolean;
  lastActivityAt: string;
  editorId: string | null;
  photographerId: string | null;
  createdByUserId: string;
  clientId: string;
  projectId: string;
  jobTypeId: string;
  estimatedHours: number | null;
  createdAt: string;
  firstSubmittedAt: string | null;
  approvedAt: string | null;
  dueDateAtApproval: string | null;
  wasOnTime: boolean | null;
  completedAt: string | null;
  cancelledAt: string | null;
  revisionCount: number;
}

const METRIC_JOB_FIELDS = {
  id: jobs.id,
  jobNumber: jobs.jobNumber,
  name: jobs.name,
  organisationId: jobs.organisationId,
  statusCategory: jobs.statusCategory,
  statusEnteredAt: jobs.statusEnteredAt,
  priority: jobs.priority,
  dueDate: jobs.dueDate,
  reviewDueDate: jobs.reviewDueDate,
  shootDate: jobs.shootDate,
  isPaused: jobs.isPaused,
  lastActivityAt: jobs.lastActivityAt,
  editorId: jobs.editorId,
  photographerId: jobs.photographerId,
  createdByUserId: jobs.createdByUserId,
  clientId: jobs.clientId,
  projectId: jobs.projectId,
  jobTypeId: jobs.jobTypeId,
  estimatedHours: jobs.estimatedHours,
  createdAt: jobs.createdAt,
  firstSubmittedAt: jobs.firstSubmittedAt,
  approvedAt: jobs.approvedAt,
  dueDateAtApproval: jobs.dueDateAtApproval,
  wasOnTime: jobs.wasOnTime,
  completedAt: jobs.completedAt,
  cancelledAt: jobs.cancelledAt,
  revisionCount: jobs.revisionCount,
};

/**
 * "org" = every job of the organisation (aggregates for management /
 * analytics viewers); "visible" = `visibleJobsWhere(ctx)` (personal views).
 */
export type MetricScope = "org" | "visible";

export interface MetricQueryOptions {
  scope: MetricScope;
  where?: SQL;
}

export function scopeWhere(ctx: AuthContext, scope: MetricScope): SQL {
  return scope === "org" ? eq(jobs.organisationId, ctx.organisationId) : visibleJobsWhere(ctx);
}

export function loadMetricJobs(db: DbLike, ctx: AuthContext, opts: MetricQueryOptions): MetricJob[] {
  return db
    .select(METRIC_JOB_FIELDS)
    .from(jobs)
    .where(and(scopeWhere(ctx, opts.scope), opts.where))
    .orderBy(asc(jobs.createdAt), asc(jobs.id))
    .all();
}

/** Jobs in ACTIVE categories. */
export function loadActiveMetricJobs(db: DbLike, ctx: AuthContext, opts: MetricQueryOptions): MetricJob[] {
  return loadMetricJobs(db, ctx, { scope: opts.scope, where: and(categoryIn(CATEGORY_GROUPS.ACTIVE), opts.where) });
}

/**
 * Dashboard KPI cards (§8) over the scope: ACTIVE jobs + jobs whose latest
 * completion falls in the current week (organisation_settings.week_starts_on).
 */
export function kpisFor(db: DbLike, ctx: AuthContext, opts: { scope: MetricScope; now?: string; weekStartsOn?: number }): KpiSummary {
  const now = opts.now ?? ctx.now();
  const weekStartsOn = opts.weekStartsOn ?? loadOrgSettings(db, ctx).weekStartsOn;
  const week = weekRangeAt(ctx, now, weekStartsOn);
  const rows = loadMetricJobs(db, ctx, {
    scope: opts.scope,
    where: or(categoryIn(CATEGORY_GROUPS.ACTIVE), and(eq(jobs.statusCategory, "completed"), gte(jobs.completedAt, week.from), lt(jobs.completedAt, week.to))),
  });
  return kpiSummary(rows, { now, tz: ctx.settings.timezone, weekRange: week });
}

/** Jobs created in [from, to). */
export function createdJobsInRange(db: DbLike, ctx: AuthContext, range: Range, opts: MetricQueryOptions): MetricJob[] {
  return loadMetricJobs(db, ctx, { scope: opts.scope, where: and(gte(jobs.createdAt, range.from), lt(jobs.createdAt, range.to), opts.where) });
}

/**
 * Jobs completed in [from, to) — §8 "Completed this week/month": the open
 * stage is `completed` and its (current) `completed_at` is in range, so a job
 * completed last week, reopened and re-completed this week counts this week
 * only. SQL prefilters on the indexed (org, completed_at) pair; the shared
 * pure `completedInRange()` makes the final decision.
 */
export function completedJobsInRange(db: DbLike, ctx: AuthContext, range: Range, opts: MetricQueryOptions): MetricJob[] {
  const rows = loadMetricJobs(db, ctx, {
    scope: opts.scope,
    where: and(eq(jobs.statusCategory, "completed"), gte(jobs.completedAt, range.from), lt(jobs.completedAt, range.to), opts.where),
  });
  return completedInRange(rows, range.from, range.to);
}

export interface ApprovedMetricJob extends MetricJob {
  /**
   * Editor credited with the approval (§8 turnaround): editor_id_at_entry of
   * the latest non-reattribution transition into `approved`, else the editor
   * assignment open at `approved_at`.
   */
  approvingEditorId: string | null;
}

// NOTE: drizzle renders columns UNQUALIFIED in the select list of a
// single-table query, so the outer job is referenced as "jobs"."…" literally
// (an interpolated ${jobs.id} would bind to the subquery's own table).
const approvingEditorSql = sql<string | null>`coalesce(
  (select t.editor_id_at_entry from job_status_transitions t
     where t.job_id = "jobs"."id" and t.to_category = 'approved' and t.kind <> 'reattribution'
     order by t.sequence desc limit 1),
  (select a.user_id from job_assignments a
     where a.job_id = "jobs"."id" and a.role = 'editor' and a.assigned_at <= "jobs"."approved_at"
       and (a.unassigned_at is null or a.unassigned_at > "jobs"."approved_at")
     order by a.assigned_at desc limit 1)
)`;

/** Jobs whose (current) `approved_at` ∈ [from, to), with the approving editor. */
export function approvedJobsInRange(db: DbLike, ctx: AuthContext, range: Range, opts: MetricQueryOptions): ApprovedMetricJob[] {
  return db
    .select({ ...METRIC_JOB_FIELDS, approvingEditorId: approvingEditorSql })
    .from(jobs)
    .where(and(scopeWhere(ctx, opts.scope), isNotNull(jobs.approvedAt), gte(jobs.approvedAt, range.from), lt(jobs.approvedAt, range.to), opts.where))
    .orderBy(asc(jobs.approvedAt), asc(jobs.id))
    .all();
}

/* ------------------------------------------------------------------ */
/*  Transitions                                                        */
/* ------------------------------------------------------------------ */

const TRANSITION_FIELDS = {
  jobId: jobStatusTransitions.jobId,
  sequence: jobStatusTransitions.sequence,
  kind: jobStatusTransitions.kind,
  toCategory: jobStatusTransitions.toCategory,
  enteredAt: jobStatusTransitions.enteredAt,
  exitedAt: jobStatusTransitions.exitedAt,
  editorIdAtEntry: jobStatusTransitions.editorIdAtEntry,
  durationSeconds: jobStatusTransitions.durationSeconds,
  isReopen: jobStatusTransitions.isReopen,
};

/** Every transition row of the given jobs, by job, in sequence order. */
export function loadTransitionsByJob(db: DbLike, ctx: AuthContext, jobIds: readonly string[]): Map<string, TransitionLike[]> {
  const out = new Map<string, TransitionLike[]>();
  const ids = [...new Set(jobIds)];
  for (const part of chunks(ids)) {
    const rows = db
      .select(TRANSITION_FIELDS)
      .from(jobStatusTransitions)
      .where(and(eq(jobStatusTransitions.organisationId, ctx.organisationId), inArray(jobStatusTransitions.jobId, part)))
      .orderBy(asc(jobStatusTransitions.jobId), asc(jobStatusTransitions.sequence))
      .all();
    for (const r of rows) {
      const list = out.get(r.jobId) ?? [];
      list.push(r);
      out.set(r.jobId, list);
    }
  }
  return out;
}

/** Transition rows held by `editorId` (editor_id_at_entry), optionally entered on/after `enteredFrom`. */
export function loadEditorTransitions(db: DbLike, ctx: AuthContext, editorId: string, opts: { enteredFrom?: string; enteredTo?: string } = {}): TransitionLike[] {
  return db
    .select(TRANSITION_FIELDS)
    .from(jobStatusTransitions)
    .where(
      and(
        eq(jobStatusTransitions.organisationId, ctx.organisationId),
        eq(jobStatusTransitions.editorIdAtEntry, editorId),
        opts.enteredFrom ? gte(jobStatusTransitions.enteredAt, opts.enteredFrom) : undefined,
        opts.enteredTo ? lt(jobStatusTransitions.enteredAt, opts.enteredTo) : undefined,
      ),
    )
    .orderBy(asc(jobStatusTransitions.enteredAt))
    .all();
}

/** Closed transitions entered in [from, to) across the org (stage averages). */
export function loadClosedTransitionsInRange(db: DbLike, ctx: AuthContext, range: Range): TransitionLike[] {
  return db
    .select(TRANSITION_FIELDS)
    .from(jobStatusTransitions)
    .where(
      and(
        eq(jobStatusTransitions.organisationId, ctx.organisationId),
        isNotNull(jobStatusTransitions.exitedAt),
        gte(jobStatusTransitions.enteredAt, range.from),
        lt(jobStatusTransitions.enteredAt, range.to),
      ),
    )
    .all();
}

/** Mean closed-stage seconds per category (optionally only rows held by `editorId`), in STATUS_CATEGORIES order. */
export function stageAverages(transitions: readonly TransitionLike[], editorId?: string): StageAverage[] {
  const sums = new Map<StatusCategory, { total: number; n: number }>();
  for (const t of transitions) {
    if (t.exitedAt === null) continue;
    if (editorId !== undefined && t.editorIdAtEntry !== editorId) continue;
    const secs = typeof t.durationSeconds === "number" ? t.durationSeconds : Math.max(0, Math.floor((Date.parse(t.exitedAt) - Date.parse(t.enteredAt)) / 1000));
    const cur = sums.get(t.toCategory) ?? { total: 0, n: 0 };
    cur.total += secs;
    cur.n += 1;
    sums.set(t.toCategory, cur);
  }
  return [...sums.entries()]
    .map(([category, { total, n }]) => ({ category, avgSeconds: total / n, count: n }))
    .sort((a, b) => STATUS_CATEGORIES.indexOf(a.category) - STATUS_CATEGORIES.indexOf(b.category));
}

/* ------------------------------------------------------------------ */
/*  Revisions / overdue events                                         */
/* ------------------------------------------------------------------ */

export interface RevisionRequestRow {
  id: string;
  jobId: string;
  requestedAt: string;
  assigneeUserId: string | null;
}

/** Revisions requested in [from, to) on jobs in scope. */
export function revisionsRequestedInRange(db: DbLike, ctx: AuthContext, range: Range, opts: MetricQueryOptions): RevisionRequestRow[] {
  return db
    .select({ id: jobRevisions.id, jobId: jobRevisions.jobId, requestedAt: jobRevisions.requestedAt, assigneeUserId: jobRevisions.assigneeUserId })
    .from(jobRevisions)
    .innerJoin(jobs, eq(jobs.id, jobRevisions.jobId))
    .where(
      and(
        eq(jobRevisions.organisationId, ctx.organisationId),
        scopeWhere(ctx, opts.scope),
        gte(jobRevisions.requestedAt, range.from),
        lt(jobRevisions.requestedAt, range.to),
        opts.where,
      ),
    )
    .all();
}

/**
 * Revision spike inputs (§8): revisions requested in the last 7 days
 * ([now − 7d, now)) and in each of the `previousWeeks` preceding 7-day
 * windows (index 0 = the week before this one), plus the affected jobs of
 * this week. One aggregate query with CASE buckets.
 */
export function revisionWeekWindows(
  db: DbLike,
  ctx: AuthContext,
  now: string,
  previousWeeks = 4,
): { thisWeek: number; previousWeeks: number[]; jobs: JobRef[] } {
  const bounds = Array.from({ length: previousWeeks + 2 }, (_, i) => isoMinusDays(now, 7 * i));
  // bounds[0] = now, bounds[1] = now − 7d, …
  const buckets = Array.from({ length: previousWeeks + 1 }, (_, i) =>
    sql<number>`sum(case when ${jobRevisions.requestedAt} >= ${bounds[i + 1]} and ${jobRevisions.requestedAt} < ${bounds[i]} then 1 else 0 end)`.mapWith(Number),
  );
  const fields: Record<string, SQL<number>> = {};
  buckets.forEach((b, i) => {
    fields[`w${i}`] = b;
  });
  const row = db
    .select(fields)
    .from(jobRevisions)
    .where(
      and(
        eq(jobRevisions.organisationId, ctx.organisationId),
        gte(jobRevisions.requestedAt, bounds[previousWeeks + 1]),
        lt(jobRevisions.requestedAt, now),
      ),
    )
    .get();
  const counts = buckets.map((_, i) => Number(row?.[`w${i}`] ?? 0) || 0);
  const affected = db
    .selectDistinct({ id: jobs.id, jobNumber: jobs.jobNumber, name: jobs.name })
    .from(jobRevisions)
    .innerJoin(jobs, eq(jobs.id, jobRevisions.jobId))
    .where(and(eq(jobRevisions.organisationId, ctx.organisationId), gte(jobRevisions.requestedAt, bounds[1]), lt(jobRevisions.requestedAt, now)))
    .orderBy(asc(jobs.jobNumber))
    .all();
  return { thisWeek: counts[0], previousWeeks: counts.slice(1), jobs: affected };
}

/** `job.became_overdue` events in [from, to) on jobs in scope (trend "became overdue"). */
export function overdueEventsInRange(db: DbLike, ctx: AuthContext, range: Range, opts: MetricQueryOptions): { jobId: string; createdAt: string }[] {
  const rows = db
    .select({ jobId: activityEvents.jobId, createdAt: activityEvents.createdAt })
    .from(activityEvents)
    .innerJoin(jobs, eq(jobs.id, activityEvents.jobId))
    .where(
      and(
        eq(activityEvents.organisationId, ctx.organisationId),
        eq(activityEvents.eventType, "job.became_overdue"),
        scopeWhere(ctx, opts.scope),
        gte(activityEvents.createdAt, range.from),
        lt(activityEvents.createdAt, range.to),
        opts.where,
      ),
    )
    .all();
  return rows.flatMap((r) => (r.jobId ? [{ jobId: r.jobId, createdAt: r.createdAt }] : []));
}

/* ------------------------------------------------------------------ */
/*  Grouped job counts (clients, projects, people)                     */
/* ------------------------------------------------------------------ */

export type JobCountKey = "clientId" | "projectId" | "photographerId" | "editorId" | "jobTypeId";

const COUNT_COLUMNS = {
  clientId: jobs.clientId,
  projectId: jobs.projectId,
  photographerId: jobs.photographerId,
  editorId: jobs.editorId,
  jobTypeId: jobs.jobTypeId,
} as const;

export const EMPTY_COUNTS: Readonly<JobCounts> = Object.freeze({ total: 0, open: 0, overdue: 0, dueToday: 0, completed: 0, completedThisMonth: 0 });

/**
 * One GROUP BY over jobs: total / open (ACTIVE) / overdue and due today
 * (DEADLINE_BOUND, compared as ISO instants exactly like lib/metrics) /
 * completed (open stage completed) / completed this month (latest completion
 * in the current civil month).
 */
export function jobCountsBy(
  db: DbLike,
  ctx: AuthContext,
  key: JobCountKey,
  opts: MetricQueryOptions & { now?: string },
): Map<string, JobCounts> {
  const now = opts.now ?? ctx.now();
  const bounds = orgDayBounds(ctx, now);
  const month = monthRangeAt(ctx, now);
  const col = COUNT_COLUMNS[key];
  const active = categoryIn(CATEGORY_GROUPS.ACTIVE);
  const bound = categoryIn(CATEGORY_GROUPS.DEADLINE_BOUND);
  const rows = db
    .select({
      key: col,
      total: sql<number>`count(*)`.mapWith(Number),
      open: sql<number>`sum(case when ${active} then 1 else 0 end)`.mapWith(Number),
      overdue: sql<number>`sum(case when ${bound} and ${jobs.dueDate} is not null and ${jobs.dueDate} < ${now} then 1 else 0 end)`.mapWith(Number),
      dueToday: sql<number>`sum(case when ${bound} and ${jobs.dueDate} >= ${now} and ${jobs.dueDate} <= ${bounds.endOfToday} then 1 else 0 end)`.mapWith(Number),
      completed: sql<number>`sum(case when ${jobs.statusCategory} = 'completed' then 1 else 0 end)`.mapWith(Number),
      completedThisMonth: sql<number>`sum(case when ${jobs.statusCategory} = 'completed' and ${jobs.completedAt} >= ${month.from} and ${jobs.completedAt} < ${month.to} then 1 else 0 end)`.mapWith(Number),
    })
    .from(jobs)
    .where(and(scopeWhere(ctx, opts.scope), isNotNull(col), opts.where))
    .groupBy(col)
    .all();
  const out = new Map<string, JobCounts>();
  for (const r of rows) {
    if (r.key === null) continue;
    out.set(r.key, {
      total: r.total || 0,
      open: r.open || 0,
      overdue: r.overdue || 0,
      dueToday: r.dueToday || 0,
      completed: r.completed || 0,
      completedThisMonth: r.completedThisMonth || 0,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Users                                                              */
/* ------------------------------------------------------------------ */

/** UserRefs for ids in the actor's organisation (foreign/missing ids are skipped). */
export function loadUserRefs(db: DbLike, ctx: AuthContext, ids: readonly (string | null | undefined)[]): Map<string, UserRef> {
  const unique = [...new Set(ids.filter((v): v is string => typeof v === "string"))];
  const out = new Map<string, UserRef>();
  for (const part of chunks(unique)) {
    const rows = db
      .select({ id: users.id, name: users.name, role: users.role, avatarColour: users.avatarColour, isActive: users.isActive })
      .from(users)
      .where(and(eq(users.organisationId, ctx.organisationId), inArray(users.id, part)))
      .all();
    for (const r of rows) out.set(r.id, r);
  }
  return out;
}

/** Groups items by a key (null keys dropped). */
export function groupBy<T>(items: readonly T[], keyOf: (t: T) => string | null | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = keyOf(item);
    if (k === null || k === undefined) continue;
    const list = out.get(k) ?? [];
    list.push(item);
    out.set(k, list);
  }
  return out;
}
