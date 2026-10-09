/**
 * Pure metric formulas (ARCHITECTURE.md §8). Every function takes plain rows
 * (already loaded and org-scoped by `src/server/queries/*`) and returns
 * numbers / view-model fragments. No DB, no clock: `now` is always passed in.
 *
 * Deadlines are ISO instants at the END of the civil day in the org timezone,
 * so "overdue" is `dueDate < now` and "due today" is `now ≤ dueDate ≤ end of
 * today` — both comparisons on instants, independent of how the end-of-day
 * instant is encoded.
 */
import {
  BOTTLENECK_DEFAULTS,
  CATEGORY_GROUPS,
  PRIORITY_META,
  STATUS_CATEGORY_META,
  WORKLOAD_THRESHOLDS,
  type BottleneckKind,
  type Priority,
  type StatusCategory,
  type WorkloadBand,
} from "@/lib/constants";
import { addCivilDays, civilDate, civilWeekRange, endOfCivilDayIso, startOfCivilDayIso, todayCivil } from "@/lib/dates";
import type { BottleneckAlert, JobRef, KpiSummary, UserRef, WorkloadHistoryPoint, WorkloadRow } from "@/lib/types";
import {
  isActiveCategory,
  isAwaitingEditor,
  isDeadlineBound,
  isEditorHolds,
  isReviewerHolds,
  isUnassignedCategory,
  isWorkloadCategory,
} from "@/lib/workflow";

export { daysRemaining } from "@/lib/dates";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const ms = (iso: string): number => Date.parse(iso);

/* ------------------------------------------------------------------ */
/*  Durations / time in stage                                          */
/* ------------------------------------------------------------------ */

/**
 * Whole seconds between `enteredAt` and `exitedAt ?? now` (floored, never
 * negative). Services must use this for `duration_seconds` so stored and
 * computed durations agree.
 */
export function durationSeconds(enteredAt: string, exitedAt: string | null | undefined, now: string): number {
  const end = ms(exitedAt ?? now);
  const start = ms(enteredAt);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return 0;
  return Math.max(0, Math.floor((end - start) / 1000));
}

/** Minimal job_status_transitions row the formulas read. */
export interface TransitionLike {
  sequence: number;
  kind: "creation" | "transition" | "reattribution" | "migration";
  toCategory: StatusCategory;
  enteredAt: string;
  exitedAt: string | null;
  editorIdAtEntry: string | null;
  durationSeconds?: number | null;
  isReopen?: boolean;
  jobId?: string;
}

const dur = (t: TransitionLike, now: string): number =>
  t.exitedAt !== null && typeof t.durationSeconds === "number" ? t.durationSeconds : durationSeconds(t.enteredAt, t.exitedAt, now);

/** Σ seconds per category over the job's transitions (open row counts up to `now`). */
export function timeInStage(transitions: readonly TransitionLike[], now: string): Partial<Record<StatusCategory, number>> {
  const out: Partial<Record<StatusCategory, number>> = {};
  for (const t of transitions) out[t.toCategory] = (out[t.toCategory] ?? 0) + dur(t, now);
  return out;
}

/** First entry into `category` (reattribution rows ignored). */
export function firstEnter(transitions: readonly TransitionLike[], category: StatusCategory): string | null {
  let best: string | null = null;
  for (const t of transitions) {
    if (t.kind === "reattribution" || t.toCategory !== category) continue;
    if (best === null || ms(t.enteredAt) < ms(best)) best = t.enteredAt;
  }
  return best;
}

/** Latest entry into `category` (reattribution rows ignored). */
export function lastEnter(transitions: readonly TransitionLike[], category: StatusCategory): string | null {
  let best: string | null = null;
  for (const t of transitions) {
    if (t.kind === "reattribution" || t.toCategory !== category) continue;
    if (best === null || ms(t.enteredAt) > ms(best)) best = t.enteredAt;
  }
  return best;
}

/** approvedAt − firstEnter(assigned) (fallback in_progress, then createdAt); null until approved. */
export function turnaroundSeconds(job: { approvedAt: string | null; createdAt: string }, transitions: readonly TransitionLike[]): number | null {
  if (!job.approvedAt) return null;
  const start = firstEnter(transitions, "assigned") ?? firstEnter(transitions, "in_progress") ?? job.createdAt;
  return durationSeconds(start, job.approvedAt, job.approvedAt);
}

const EDITING: readonly StatusCategory[] = ["in_progress", "revision"];

/** Σ stage time in in_progress + revision; per editor via editor_id_at_entry (reattribution-aware). */
export function editingSeconds(transitions: readonly TransitionLike[], now: string, editorId?: string): number {
  let total = 0;
  for (const t of transitions) {
    if (!EDITING.includes(t.toCategory)) continue;
    if (editorId !== undefined && t.editorIdAtEntry !== editorId) continue;
    total += dur(t, now);
  }
  return total;
}

/** Σ stage time in REVIEWER_HOLDS. */
export function reviewSeconds(transitions: readonly TransitionLike[], now: string): number {
  let total = 0;
  for (const t of transitions) if (isReviewerHolds(t.toCategory)) total += dur(t, now);
  return total;
}

/** Mean closed-stage duration per category for one editor (Avg time per stage). */
export function avgSecondsPerCategory(transitions: readonly TransitionLike[], editorId: string): Partial<Record<StatusCategory, number>> {
  const sums = new Map<StatusCategory, { total: number; n: number }>();
  for (const t of transitions) {
    if (t.exitedAt === null || t.editorIdAtEntry !== editorId) continue;
    const cur = sums.get(t.toCategory) ?? { total: 0, n: 0 };
    cur.total += dur(t, t.exitedAt);
    cur.n += 1;
    sums.set(t.toCategory, cur);
  }
  const out: Partial<Record<StatusCategory, number>> = {};
  for (const [c, { total, n }] of sums) out[c] = total / n;
  return out;
}

/** Editor credited with an approval: editor_id_at_entry of the latest transition into approved. */
export function approvingEditorId(transitions: readonly TransitionLike[]): string | null {
  let latest: TransitionLike | null = null;
  for (const t of transitions) {
    if (t.toCategory !== "approved" || t.kind === "reattribution") continue;
    if (latest === null || t.sequence > latest.sequence) latest = t;
  }
  return latest?.editorIdAtEntry ?? null;
}

/**
 * Photographer processing times: firstSubmittedAt − START of the shoot's civil
 * day (org tz) and completedAt − createdAt. `shoot_date` is stored like a
 * deadline (the LAST millisecond of the civil day), so subtracting it raw
 * made a same-day submission negative; measuring from the start of the
 * shoot day and clamping at 0 keeps "processing time" a real duration.
 */
export function photographerProcessingSeconds(
  job: {
    shootDate: string | null;
    firstSubmittedAt: string | null;
    createdAt: string;
    completedAt: string | null;
  },
  timeZone?: string,
): { processing: number | null; endToEnd: number | null } {
  let processing: number | null = null;
  if (job.shootDate && job.firstSubmittedAt) {
    const shootCivil = civilDate(job.shootDate, timeZone);
    const shootStart = shootCivil ? startOfCivilDayIso(shootCivil, timeZone) : job.shootDate;
    processing = durationSeconds(shootStart, job.firstSubmittedAt, job.firstSubmittedAt);
  }
  return {
    processing,
    endToEnd: job.completedAt ? durationSeconds(job.createdAt, job.completedAt, job.completedAt) : null,
  };
}

/* ------------------------------------------------------------------ */
/*  Rates                                                              */
/* ------------------------------------------------------------------ */

export interface Range {
  /** Inclusive ISO start. */
  from: string;
  /** Exclusive ISO end. */
  to: string;
}

const inRange = (iso: string | null, range?: Range): boolean =>
  iso !== null && (range === undefined || (ms(iso) >= ms(range.from) && ms(iso) < ms(range.to)));

/**
 * Revision rate over jobs approved (in `range` when given). Callers filter the
 * jobs to the approving editor for per-editor rates.
 */
export function revisionRate(
  jobs: readonly { approvedAt: string | null; revisionCount: number }[],
  range?: Range,
): { rate: number | null; revisionsPerJob: number | null; jobsApproved: number; jobsWithRevision: number } {
  const approved = jobs.filter((j) => inRange(j.approvedAt, range));
  const jobsApproved = approved.length;
  const jobsWithRevision = approved.filter((j) => j.revisionCount >= 1).length;
  const revisions = approved.reduce((s, j) => s + j.revisionCount, 0);
  return {
    rate: jobsApproved === 0 ? null : jobsWithRevision / jobsApproved,
    revisionsPerJob: jobsApproved === 0 ? null : revisions / jobsApproved,
    jobsApproved,
    jobsWithRevision,
  };
}

/**
 * On-time % = on-time approvals / approvals with a due date, judged against the
 * due date IN FORCE AT APPROVAL (`dueDateAtApproval`); the current `dueDate`
 * is deliberately ignored.
 */
export function onTimeRate(
  jobs: readonly { approvedAt: string | null; dueDateAtApproval: string | null; wasOnTime?: boolean | null; dueDate?: string | null }[],
  range?: Range,
): { rate: number | null; onTime: number; measured: number } {
  let onTime = 0;
  let measured = 0;
  for (const j of jobs) {
    if (!inRange(j.approvedAt, range) || j.dueDateAtApproval === null || j.approvedAt === null) continue;
    measured += 1;
    const ok = typeof j.wasOnTime === "boolean" ? j.wasOnTime : ms(j.approvedAt) <= ms(j.dueDateAtApproval);
    if (ok) onTime += 1;
  }
  return { rate: measured === 0 ? null : onTime / measured, onTime, measured };
}

/**
 * Jobs completed in [from, to): the job's open stage is `completed` and its
 * (current) `completedAt` is in range. A job completed last week, reopened
 * and re-completed this week counts this week only.
 */
export function completedInRange<T extends { statusCategory: StatusCategory; completedAt: string | null }>(jobs: readonly T[], from: string, to: string): T[] {
  return jobs.filter((j) => j.statusCategory === "completed" && inRange(j.completedAt, { from, to }));
}

/* ------------------------------------------------------------------ */
/*  Deadlines + KPIs                                                   */
/* ------------------------------------------------------------------ */

/** Editing deadline passed (only meaningful for DEADLINE_BOUND categories). */
export function isPastDue(dueDate: string | null, now: string): boolean {
  return dueDate !== null && ms(dueDate) < ms(now);
}

/** Not yet overdue and due by the end of today (org tz). */
export function isDueTodayAt(dueDate: string | null, now: string, timeZone: string): boolean {
  if (dueDate === null || isPastDue(dueDate, now)) return false;
  const endOfToday = endOfCivilDayIso(todayCivil(timeZone, new Date(now)), timeZone);
  return ms(dueDate) <= ms(endOfToday);
}

/** Due within `hours` from now (including already overdue). */
export function isDueWithinHours(dueDate: string | null, now: string, hours: number): boolean {
  return dueDate !== null && ms(dueDate) - ms(now) <= hours * HOUR_MS;
}

export interface KpiJob {
  statusCategory: StatusCategory;
  dueDate: string | null;
  reviewDueDate?: string | null;
  isPaused?: boolean;
  completedAt: string | null;
}

/** Dashboard KPI cards (§8). `weekRange` defaults to the Mon–Sun civil week containing now. */
export function kpiSummary(jobs: readonly KpiJob[], opts: { now: string; tz: string; weekRange?: Range }): KpiSummary {
  const { now, tz } = opts;
  const week =
    opts.weekRange ??
    (() => {
      const [start, end] = civilWeekRange(todayCivil(tz, new Date(now)));
      return { from: startOfCivilDayIso(start, tz), to: startOfCivilDayIso(end, tz) };
    })();
  const k: KpiSummary = {
    active: 0,
    dueToday: 0,
    overdue: 0,
    awaitingEditor: 0,
    inEditing: 0,
    awaitingReview: 0,
    revisionRequired: 0,
    completedThisWeek: completedInRange(jobs, week.from, week.to).length,
    unassigned: 0,
    paused: 0,
    reviewOverdue: 0,
    asOf: now,
    completedWeek: { from: week.from, to: week.to },
  };
  for (const j of jobs) {
    const c = j.statusCategory;
    if (isActiveCategory(c)) k.active += 1;
    if (isDeadlineBound(c)) {
      if (isPastDue(j.dueDate, now)) k.overdue += 1;
      else if (isDueTodayAt(j.dueDate, now, tz)) k.dueToday += 1;
    }
    if (isAwaitingEditor(c)) k.awaitingEditor += 1;
    if (c === "in_progress") k.inEditing += 1;
    if (isReviewerHolds(c)) {
      k.awaitingReview += 1;
      if (isPastDue(j.reviewDueDate ?? null, now)) k.reviewOverdue += 1;
    }
    if (c === "revision") k.revisionRequired += 1;
    if (isUnassignedCategory(c)) k.unassigned += 1;
    if (j.isPaused && isActiveCategory(c)) k.paused += 1;
  }
  return k;
}

/* ------------------------------------------------------------------ */
/*  Workload                                                           */
/* ------------------------------------------------------------------ */

export interface WorkloadSettings {
  defaultEstimatedHours?: number;
  defaultCapacityHoursPerWeek?: number;
  workloadNearCapacityRatio?: number;
  workloadOverloadedRatio?: number;
  maxActiveJobsPerEditor?: number;
}

export interface WorkloadJob {
  statusCategory: StatusCategory;
  priority: Priority;
  dueDate: string | null;
  estimatedHours: number | null;
  jobTypeId: string;
}

/** Overdue jobs at which an editor is forced into the overloaded band. */
export const OVERDUE_HARD_CAP = 3;

/** dueWeight: overdue 1.5, due within 48h 1.25, else 1. */
export function dueWeight(dueDate: string | null, now: string): number {
  if (dueDate === null) return 1;
  if (isPastDue(dueDate, now)) return WORKLOAD_THRESHOLDS.overdueWeight;
  if (isDueWithinHours(dueDate, now, WORKLOAD_THRESHOLDS.dueSoonHours)) return WORKLOAD_THRESHOLDS.dueSoonWeight;
  return 1;
}

/** Contribution of one job to its editor's workload score (0 outside WORKLOAD). */
export function jobWorkloadScore(
  job: WorkloadJob,
  opts: { settings: WorkloadSettings; jobTypeDefaults: Readonly<Record<string, number | null | undefined>>; now: string },
): number {
  if (!isWorkloadCategory(job.statusCategory)) return 0;
  const hours =
    job.estimatedHours ??
    opts.jobTypeDefaults[job.jobTypeId] ??
    opts.settings.defaultEstimatedHours ??
    WORKLOAD_THRESHOLDS.defaultEstimatedHours;
  return hours * PRIORITY_META[job.priority].weight * dueWeight(job.dueDate, opts.now) * STATUS_CATEGORY_META[job.statusCategory].workloadWeight;
}

/** Σ estHours × priorityWeight × dueWeight × categoryWeight over the editor's jobs. */
export function workloadScore(
  jobs: readonly WorkloadJob[],
  opts: { settings: WorkloadSettings; jobTypeDefaults: Readonly<Record<string, number | null | undefined>>; now: string; tz?: string },
): number {
  let score = 0;
  for (const j of jobs) score += jobWorkloadScore(j, opts);
  return score;
}

/** Ratio reported when capacity is 0 but there is load (keeps JSON finite). */
const NO_CAPACITY_RATIO = 999;

export function workloadBand(
  score: number,
  opts: { capacityHours: number | null; settings: WorkloadSettings; activeCount: number; overdueCount: number; isActive: boolean },
): { band: WorkloadBand; ratio: number; reason: WorkloadRow["bandReason"] } {
  const s = opts.settings;
  const capacity = opts.capacityHours ?? s.defaultCapacityHoursPerWeek ?? WORKLOAD_THRESHOLDS.defaultCapacityHoursPerWeek;
  const ratio = capacity > 0 ? score / capacity : score > 0 ? NO_CAPACITY_RATIO : 0;
  if (!opts.isActive) return { band: "overloaded", ratio, reason: "inactive" };
  if (opts.activeCount >= (s.maxActiveJobsPerEditor ?? WORKLOAD_THRESHOLDS.maxActiveJobsPerEditor)) {
    return { band: "overloaded", ratio, reason: "max_active" };
  }
  if (opts.overdueCount >= OVERDUE_HARD_CAP) return { band: "overloaded", ratio, reason: "overdue_cap" };
  const over = s.workloadOverloadedRatio ?? WORKLOAD_THRESHOLDS.overloadedRatio;
  const near = s.workloadNearCapacityRatio ?? WORKLOAD_THRESHOLDS.nearCapacityRatio;
  if (ratio >= over) return { band: "overloaded", ratio, reason: "ratio" };
  if (ratio >= near) return { band: "near_capacity", ratio, reason: "ratio" };
  return { band: "healthy", ratio, reason: "ratio" };
}

/* ------------------------------------------------------------------ */
/*  Historical workload (§8 last row)                                  */
/* ------------------------------------------------------------------ */

export interface AssignmentLike {
  jobId: string;
  userId: string;
  role: "photographer" | "editor";
  assignedAt: string;
  unassignedAt: string | null;
}

export interface HistoryTransitionLike {
  jobId: string;
  toCategory: StatusCategory;
  enteredAt: string;
  exitedAt: string | null;
}

/**
 * For each civil day d in [range.from, range.to] (inclusive civil dates), the
 * jobs the editor held at the END of d (clipped to `now` for today): an
 * editor assignment open at that instant AND the transition open at that
 * instant in EDITOR_HOLDS. Score = hours × category weight (priority/due
 * weights are not historical, so they are not applied).
 */
export function historicalWorkloadSeries(
  assignments: readonly AssignmentLike[],
  transitions: readonly HistoryTransitionLike[],
  range: { from: string; to: string; timeZone: string; now: string },
  opts: { editorId?: string; jobHours?: Readonly<Record<string, number>>; defaultHours?: number } = {},
): WorkloadHistoryPoint[] {
  const editorRows = assignments.filter((a) => a.role === "editor" && (opts.editorId === undefined || a.userId === opts.editorId));
  const byJob = new Map<string, HistoryTransitionLike[]>();
  for (const t of transitions) byJob.set(t.jobId, [...(byJob.get(t.jobId) ?? []), t]);
  const openAt = (start: string, end: string | null, at: number) => ms(start) <= at && (end === null || at < ms(end));
  const nowMs = ms(range.now);
  const points: WorkloadHistoryPoint[] = [];
  for (let d = range.from; d <= range.to; d = addCivilDays(d, 1)) {
    const at = Math.min(ms(endOfCivilDayIso(d, range.timeZone)), nowMs);
    const jobIds = new Set<string>();
    for (const a of editorRows) if (openAt(a.assignedAt, a.unassignedAt, at)) jobIds.add(a.jobId);
    let count = 0;
    let score = 0;
    for (const jobId of jobIds) {
      const stage = (byJob.get(jobId) ?? []).find((t) => openAt(t.enteredAt, t.exitedAt, at));
      if (!stage || !isEditorHolds(stage.toCategory)) continue;
      count += 1;
      score += (opts.jobHours?.[jobId] ?? opts.defaultHours ?? WORKLOAD_THRESHOLDS.defaultEstimatedHours) * STATUS_CATEGORY_META[stage.toCategory].workloadWeight;
    }
    points.push({ date: d, count, score });
  }
  return points;
}

/* ------------------------------------------------------------------ */
/*  Bottlenecks (§8)                                                   */
/* ------------------------------------------------------------------ */

export interface BottleneckSettings {
  reviewBottleneckHours: number;
  reviewBottleneckMinJobs: number;
  editingBottleneckDueWithinHours: number;
  editingBottleneckMinDueSoon: number;
  unassignedBacklogMin: number;
  stalledDays: number;
  revisionSpikeMinCount: number;
  revisionSpikeMultiplier: number;
  maxActiveJobsPerEditor: number;
}

export interface BottleneckJob extends JobRef {
  statusCategory: StatusCategory;
  statusEnteredAt: string;
  dueDate: string | null;
  reviewDueDate: string | null;
  isPaused: boolean;
  lastActivityAt: string;
  editorId: string | null;
}

export interface BottleneckEditor {
  user: UserRef;
  band: WorkloadBand;
  /** Active jobs held (WorkloadRow.active). */
  active: number;
  /** Active jobs due within `editingBottleneckDueWithinHours`. */
  dueSoon: number;
}

export interface BottleneckInput {
  now: string;
  settings?: Partial<BottleneckSettings>;
  /** Org jobs (non-active ones are ignored). */
  jobs: readonly BottleneckJob[];
  editors: readonly BottleneckEditor[];
  /**
   * Revision REQUESTS in the last 7 days and in each of the previous (up to 4)
   * 7-day windows, plus the distinct jobs those requests were made on this
   * week (the alert's `count` / `jobs`).
   */
  revisions: { thisWeek: number; previousWeeks: readonly number[]; jobs?: readonly JobRef[] };
  /** Users that are deactivated (editor_unavailable); editors with isActive=false are added automatically. */
  inactiveUserIds?: readonly string[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const ref = (j: JobRef): JobRef => ({ id: j.id, jobNumber: j.jobNumber, name: j.name });
const isoParam = (msValue: number) => encodeURIComponent(new Date(msValue).toISOString());

/** Evaluates all BOTTLENECK_KINDS; returns the alerts that fire, in BOTTLENECK_KINDS order. */
export function evaluateBottlenecks(input: BottleneckInput): BottleneckAlert[] {
  const s: BottleneckSettings = {
    ...BOTTLENECK_DEFAULTS,
    maxActiveJobsPerEditor: WORKLOAD_THRESHOLDS.maxActiveJobsPerEditor,
    ...input.settings,
  };
  const now = input.now;
  const nowMs = ms(now);
  const active = input.jobs.filter((j) => isActiveCategory(j.statusCategory));
  const alerts: BottleneckAlert[] = [];
  const push = (kind: BottleneckKind, a: Omit<BottleneckAlert, "kind" | "detectedAt">) => alerts.push({ kind, detectedAt: now, ...a });

  // review
  const waiting = active.filter((j) => isReviewerHolds(j.statusCategory) && nowMs - ms(j.statusEnteredAt) > s.reviewBottleneckHours * HOUR_MS);
  if (waiting.length >= s.reviewBottleneckMinJobs && waiting.length > 0) {
    push("review", {
      severity: waiting.length >= 2 * s.reviewBottleneckMinJobs ? "critical" : "warning",
      message: `Review bottleneck — ${plural(waiting.length, "job", "jobs")} waiting for review > ${s.reviewBottleneckHours}h`,
      count: waiting.length,
      user: null,
      jobs: waiting.map(ref),
      // statusEnteredBefore reproduces "now − status_entered_at > h" exactly.
      href: `/workspace/all?quick=awaiting_review&statusEnteredBefore=${isoParam(nowMs - s.reviewBottleneckHours * HOUR_MS)}`,
    });
  }

  // editor_overloaded (inactive editors are reported by editor_unavailable instead)
  for (const e of input.editors) {
    if (!e.user.isActive) continue;
    const capped = e.active >= s.maxActiveJobsPerEditor && e.dueSoon >= s.editingBottleneckMinDueSoon;
    if (e.band !== "overloaded" && !capped) continue;
    // Same set as WorkloadRow.active (held = WORKLOAD categories), so the list matches the count.
    const theirs = active.filter((j) => j.editorId === e.user.id && isWorkloadCategory(j.statusCategory));
    push("editor_overloaded", {
      severity: e.band === "overloaded" && capped ? "critical" : "warning",
      message: `Editing bottleneck — ${e.user.name} has ${e.active} active ${e.active === 1 ? "job" : "jobs"}, ${e.dueSoon} due within ${s.editingBottleneckDueWithinHours}h`,
      count: e.active,
      user: e.user,
      jobs: theirs.map(ref),
      href: `/workspace/all?editorId=${encodeURIComponent(e.user.id)}&statusCategory=${CATEGORY_GROUPS.WORKLOAD.join(",")}`,
    });
  }

  // revision_spike
  const prev = input.revisions.previousWeeks.slice(0, 4);
  const baseline = prev.length === 0 ? 0 : prev.reduce((a, b) => a + b, 0) / prev.length;
  const n = input.revisions.thisWeek;
  if (n >= s.revisionSpikeMinCount && (baseline === 0 || n >= s.revisionSpikeMultiplier * baseline)) {
    // The rule fires on REQUEST counts (§8); the alert counts and lists the distinct jobs.
    const affected = input.revisions.jobs;
    const requests = plural(n, "revision request", "revision requests");
    push("revision_spike", {
      severity: baseline > 0 && n >= 2 * s.revisionSpikeMultiplier * baseline ? "critical" : "warning",
      message: affected
        ? `Revision bottleneck — ${requests} on ${plural(affected.length, "job", "jobs")} in the last 7 days`
        : `Revision bottleneck — ${requests} in the last 7 days`,
      count: affected ? affected.length : n,
      user: null,
      jobs: (affected ?? []).map(ref),
      // Every job with a revision requested in the window (cancelled ones included, as in the alert).
      href: `/workspace/all?revisedFrom=${isoParam(nowMs - 7 * DAY_MS)}&includeCancelled=1`,
    });
  }

  // unassigned_backlog
  const unassigned = active.filter((j) => isUnassignedCategory(j.statusCategory));
  const dueSoon = unassigned.filter((j) => isDueWithinHours(j.dueDate, now, WORKLOAD_THRESHOLDS.dueSoonHours));
  if (unassigned.length > 0 && (unassigned.length >= s.unassignedBacklogMin || dueSoon.length > 0)) {
    push("unassigned_backlog", {
      severity: dueSoon.length > 0 ? "critical" : "warning",
      message: `Unassigned backlog — ${plural(unassigned.length, "job", "jobs")} waiting for an editor (${dueSoon.length} due within ${WORKLOAD_THRESHOLDS.dueSoonHours}h)`,
      count: unassigned.length,
      user: null,
      jobs: unassigned.map(ref),
      href: "/workspace/all?quick=unassigned",
    });
  }

  // stalled
  const stalled = active.filter((j) => !j.isPaused && ms(j.lastActivityAt) < nowMs - s.stalledDays * DAY_MS);
  if (stalled.length > 0) {
    push("stalled", {
      severity: "warning",
      message: `Stalled — ${plural(stalled.length, "job", "jobs")} with no activity for ${s.stalledDays} days`,
      count: stalled.length,
      user: null,
      jobs: stalled.map(ref),
      href: "/insights/bottlenecks#stalled",
    });
  }

  // editor_unavailable
  const inactive = new Set<string>([...(input.inactiveUserIds ?? []), ...input.editors.filter((e) => !e.user.isActive).map((e) => e.user.id)]);
  const orphaned = active.filter((j) => j.editorId !== null && inactive.has(j.editorId));
  if (orphaned.length > 0) {
    push("editor_unavailable", {
      severity: "critical",
      message: `${plural(orphaned.length, "job", "jobs")} assigned to a deactivated editor`,
      count: orphaned.length,
      user: null,
      jobs: orphaned.map(ref),
      href: "/insights/bottlenecks#editor_unavailable",
    });
  }

  // review_overdue
  const reviewLate = active.filter((j) => isReviewerHolds(j.statusCategory) && isPastDue(j.reviewDueDate, now));
  if (reviewLate.length > 0) {
    push("review_overdue", {
      severity: "warning",
      message: `Review deadlines passed — ${plural(reviewLate.length, "job", "jobs")}`,
      count: reviewLate.length,
      user: null,
      jobs: reviewLate.map(ref),
      href: "/insights/bottlenecks#review_overdue",
    });
  }

  return alerts;
}
