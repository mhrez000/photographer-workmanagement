/**
 * Pure formulas for the simplified Editors page, the editor's My jobs footer
 * and the Home "Your editors" block (docs/SIMPLIFICATION-PLAN.md §6, §7).
 *
 * The five numbers, measured the same way everywhere:
 *   On their desk   = jobs the editor holds now (With editor + Changes asked)
 *   Late now        = of those, due day before today (org tz)
 *   Finished        = jobs approved in the period, credited to the editor
 *   On time         = % of finished jobs the editor FIRST sent for checking
 *                     on/before the due day (first_submitted_at ≤ due); the
 *                     reviewer's own delay never counts against the editor
 *   Needed changes  = % of finished jobs with at least one round of changes
 *
 * Fairness rule: below MIN_JOBS_FOR_RATES finished jobs the two percentages
 * are null and `notEnough` is true ("Not enough jobs yet").
 *
 * No DB, no clock: `now` is always passed in. Dates are ISO instants; period
 * bounds are civil months in the organisation timezone.
 */
import { addCivilDays, civilDate, civilDiffDays, civilMonthRange, civilWeekRange, startOfCivilDayIso, todayCivil } from "@/lib/dates";
import type { EditorPeriodKey, EditorPeriodRange, EditorNumberDelta, FinishedPerWeekPoint } from "@/lib/types";

/** Fewer finished jobs than this → percentages show "Not enough jobs yet". */
export const MIN_JOBS_FOR_RATES = 5;

export const EDITOR_PERIODS: readonly EditorPeriodKey[] = ["this_month", "last_month", "last_3_months"];

export const EDITOR_PERIOD_LABELS: Record<EditorPeriodKey, string> = {
  this_month: "This month",
  last_month: "Last month",
  last_3_months: "Last 3 months",
};

const MONTHS_IN_PERIOD: Record<EditorPeriodKey, number> = { this_month: 1, last_month: 1, last_3_months: 3 };

/** First day of the month `offset` months before/after the month containing `civil`. */
function monthStartShift(civil: string, offset: number): string {
  const [y, m] = civil.split("-").map(Number);
  const total = y * 12 + (m - 1) + offset;
  const yy = Math.floor(total / 12);
  const mm = (total % 12) + 1;
  return `${yy}-${String(mm).padStart(2, "0")}-01`;
}

/** Civil [start, endExclusive) of a period relative to today (org tz). `shift` moves whole periods back (1 = the previous period). */
function periodCivilBounds(period: EditorPeriodKey, today: string, shift = 0): [string, string] {
  const months = MONTHS_IN_PERIOD[period];
  const [thisMonthStart] = civilMonthRange(today);
  // Current period: this_month → [this month); last_month → [previous month); last_3_months → [this month − 2, next month).
  const endOffset = period === "last_month" ? 0 : 1;
  const end = monthStartShift(thisMonthStart, endOffset - shift * months);
  const start = monthStartShift(end, -months);
  return [start, end];
}

/** ISO bounds of a period in the organisation timezone. */
export function periodRange(period: EditorPeriodKey, timeZone: string, now: string): EditorPeriodRange {
  const today = todayCivil(timeZone, new Date(now));
  const [start, end] = periodCivilBounds(period, today);
  return { period, from: startOfCivilDayIso(start, timeZone), to: startOfCivilDayIso(end, timeZone), label: EDITOR_PERIOD_LABELS[period] };
}

/** The period of the same length immediately before `period` (for "vs last month" deltas). */
export function previousPeriodRange(period: EditorPeriodKey, timeZone: string, now: string): EditorPeriodRange {
  const today = todayCivil(timeZone, new Date(now));
  const [start, end] = periodCivilBounds(period, today, 1);
  return { period, from: startOfCivilDayIso(start, timeZone), to: startOfCivilDayIso(end, timeZone), label: `Before ${EDITOR_PERIOD_LABELS[period].toLowerCase()}` };
}

/* ------------------------------------------------------------------ */
/*  Late                                                               */
/* ------------------------------------------------------------------ */

/**
 * Civil due day of a stored deadline instant, read 1 ms early so both
 * encodings (`23:59:59.999` and `next day 00:00`) map to the intended day.
 */
export function dueCivilDay(dueDate: string | null, timeZone: string): string | null {
  if (!dueDate) return null;
  const t = Date.parse(dueDate);
  if (!Number.isFinite(t)) return null;
  return civilDate(new Date(t - 1), timeZone);
}

/** Days from `today` (civil) to the due day; negative = past. */
export function daysFromToday(dueDate: string | null, today: string, timeZone: string): number | null {
  const due = dueCivilDay(dueDate, timeZone);
  return due === null ? null : civilDiffDays(today, due);
}

/** "Late" = the due day is before today. Callers AND this with "active stage" (Done / Cancelled are never late). */
export function isLateCivil(dueDate: string | null, today: string, timeZone: string): boolean {
  const d = daysFromToday(dueDate, today, timeZone);
  return d !== null && d < 0;
}

/* ------------------------------------------------------------------ */
/*  On time (submit-based) + needed changes                             */
/* ------------------------------------------------------------------ */

export interface FinishedJobLike {
  approvedAt: string | null;
  /** Due date in force when approved (preferred); falls back to `dueDate`. */
  dueDateAtApproval?: string | null;
  dueDate: string | null;
  /** The editor's FIRST send-for-checking. */
  firstSubmittedAt: string | null;
  revisionCount: number;
}

/** The due instant a finished job is judged against. */
export function judgedDue(job: Pick<FinishedJobLike, "dueDateAtApproval" | "dueDate">): string | null {
  return job.dueDateAtApproval ?? job.dueDate ?? null;
}

/**
 * The editor sent the job for checking on/before its due day. null when the
 * job has no due date or was never sent for checking.
 */
export function submittedOnTime(job: FinishedJobLike, timeZone: string): boolean | null {
  const due = judgedDue(job);
  if (due === null || job.firstSubmittedAt === null) return null;
  const dueDay = dueCivilDay(due, timeZone);
  const sentDay = civilDate(job.firstSubmittedAt, timeZone);
  if (dueDay === null || sentDay === null) return null;
  return sentDay <= dueDay;
}

/** Whole days the first send-for-checking was past the due day (0 when on time; null when not measurable). */
export function daysLateBySubmit(job: FinishedJobLike, timeZone: string): number | null {
  const due = judgedDue(job);
  if (due === null || job.firstSubmittedAt === null) return null;
  const dueDay = dueCivilDay(due, timeZone);
  const sentDay = civilDate(job.firstSubmittedAt, timeZone);
  if (dueDay === null || sentDay === null) return null;
  return Math.max(0, civilDiffDays(dueDay, sentDay));
}

/** 0–100 whole-number percentage; null when `whole` is 0. */
export function percent(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 100);
}

export interface RateResult {
  /** Whole-number percentage, or null (not enough jobs / nothing measurable). */
  pct: number | null;
  /** Numerator. */
  count: number;
  /** Denominator actually measured. */
  measured: number;
  /** Fewer than MIN_JOBS_FOR_RATES finished jobs. */
  notEnough: boolean;
}

/**
 * On time % over finished jobs = on-time sends / jobs with a due date and a
 * send. Below MIN_JOBS_FOR_RATES finished jobs → null + notEnough.
 */
export function onTimeBySubmitPct(finished: readonly FinishedJobLike[], timeZone: string, minJobs = MIN_JOBS_FOR_RATES): RateResult {
  let onTime = 0;
  let measured = 0;
  for (const j of finished) {
    const ok = submittedOnTime(j, timeZone);
    if (ok === null) continue;
    measured += 1;
    if (ok) onTime += 1;
  }
  const notEnough = finished.length < minJobs;
  return { pct: notEnough ? null : percent(onTime, measured), count: onTime, measured, notEnough };
}

/** Needed changes % = finished jobs with revision_count ≥ 1 / finished jobs (same threshold). */
export function neededChangesPct(finished: readonly { revisionCount: number }[], minJobs = MIN_JOBS_FOR_RATES): RateResult {
  const withChanges = finished.filter((j) => j.revisionCount >= 1).length;
  const notEnough = finished.length < minJobs;
  return { pct: notEnough ? null : percent(withChanges, finished.length), count: withChanges, measured: finished.length, notEnough };
}

/** current − previous (null when either side is missing). */
export function numberDelta(current: number | null, previous: number | null): EditorNumberDelta {
  return { current, previous, delta: current === null || previous === null ? null : current - previous };
}

/* ------------------------------------------------------------------ */
/*  Average days to edit + weekly series                                */
/* ------------------------------------------------------------------ */

/** Mean (approved − editing started) in days, one decimal; null without measurable jobs. */
export function averageDaysToEdit(items: readonly { approvedAt: string | null; editingStartedAt: string | null }[]): number | null {
  let total = 0;
  let n = 0;
  for (const i of items) {
    if (!i.approvedAt || !i.editingStartedAt) continue;
    const ms = Date.parse(i.approvedAt) - Date.parse(i.editingStartedAt);
    if (!Number.isFinite(ms) || ms < 0) continue;
    total += ms / 86_400_000;
    n += 1;
  }
  return n === 0 ? null : Math.round((total / n) * 10) / 10;
}

export interface WeekBucket {
  /** Civil start of the week. */
  weekStart: string;
  from: string;
  /** Exclusive. */
  to: string;
}

/** The last `weeks` civil weeks (oldest first), the current week last, honouring `weekStartsOn`. */
export function weekBuckets(now: string, timeZone: string, weekStartsOn: number, weeks = 12): WeekBucket[] {
  const today = todayCivil(timeZone, new Date(now));
  const [thisWeekStart] = civilWeekRange(today, weekStartsOn);
  const out: WeekBucket[] = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const start = addCivilDays(thisWeekStart, -7 * i);
    out.push({ weekStart: start, from: startOfCivilDayIso(start, timeZone), to: startOfCivilDayIso(addCivilDays(start, 7), timeZone) });
  }
  return out;
}

/** Finished-per-week series: approvals bucketed into `buckets`. */
export function finishedPerWeek(approvedAts: readonly string[], buckets: readonly WeekBucket[]): FinishedPerWeekPoint[] {
  return buckets.map((b) => ({ weekStart: b.weekStart, finished: approvedAts.filter((at) => at >= b.from && at < b.to).length }));
}

/** "On their desk" capacity state: full when a usual capacity is set and reached. */
export function isDeskFull(onDesk: number, usualCapacity: number | null): boolean {
  return usualCapacity !== null && usualCapacity > 0 && onDesk >= usualCapacity;
}
