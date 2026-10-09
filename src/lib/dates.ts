/**
 * Date helpers. All timestamps are stored as ISO-8601 UTC strings. Display
 * helpers take the organisation timezone (IANA name) so "today" / "overdue"
 * are judged on the studio's clock, not the server's.
 */

export const DEFAULT_TIMEZONE = "Australia/Sydney";

export type DateInput = string | Date | null | undefined;

/** Intl formatters are expensive to build; day-bound math calls them in loops. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function cachedFormat(kind: string, timeZone: string, options: () => Intl.DateTimeFormatOptions, locale: string): Intl.DateTimeFormat {
  const key = `${kind}|${timeZone}`;
  let f = FORMATTERS.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options());
    FORMATTERS.set(key, f);
  }
  return f;
}

export function toDate(value: DateInput): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Returns the civil date (YYYY-MM-DD) of `value` in `timeZone`. */
export function civilDate(value: DateInput, timeZone = DEFAULT_TIMEZONE): string | null {
  const d = toDate(value);
  if (!d) return null;
  const parts = cachedFormat("civil", timeZone, () => ({ timeZone, year: "numeric", month: "2-digit", day: "2-digit" }), "en-CA").formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Civil date of "now" in the timezone. */
export function todayCivil(timeZone = DEFAULT_TIMEZONE, now: Date = new Date()): string {
  return civilDate(now, timeZone) as string;
}

/** Adds whole days to a civil date string (YYYY-MM-DD). */
export function addCivilDays(civil: string, days: number): string {
  const [y, m, d] = civil.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Difference in whole civil days between two YYYY-MM-DD strings (b - a). */
export function civilDiffDays(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/**
 * Days remaining until `due` relative to today in the timezone.
 * Negative = overdue by that many days. null when no due date.
 */
export function daysRemaining(due: DateInput, timeZone = DEFAULT_TIMEZONE, now: Date = new Date()): number | null {
  const dueCivil = civilDate(due, timeZone);
  if (!dueCivil) return null;
  return civilDiffDays(todayCivil(timeZone, now), dueCivil);
}

export function isDueToday(due: DateInput, timeZone = DEFAULT_TIMEZONE, now: Date = new Date()): boolean {
  return daysRemaining(due, timeZone, now) === 0;
}

export function isDueTomorrow(due: DateInput, timeZone = DEFAULT_TIMEZONE, now: Date = new Date()): boolean {
  return daysRemaining(due, timeZone, now) === 1;
}

/** Overdue = due date is before today (civil) — jobs due later today are not overdue yet. */
export function isOverdue(due: DateInput, timeZone = DEFAULT_TIMEZONE, now: Date = new Date()): boolean {
  const r = daysRemaining(due, timeZone, now);
  return r !== null && r < 0;
}

export function isDueWithinDays(due: DateInput, days: number, timeZone = DEFAULT_TIMEZONE, now: Date = new Date()): boolean {
  const r = daysRemaining(due, timeZone, now);
  return r !== null && r >= 0 && r <= days;
}

/** Start of the civil day (as an ISO instant) in the timezone. */
export function startOfCivilDayIso(civil: string, timeZone = DEFAULT_TIMEZONE): string {
  // The start of a civil day is the FIRST instant whose civil date (in
  // `timeZone`) is `civil`. Usually that is local midnight: the fixed point
  // s = guess − offset(s), using the offset in force AT that midnight (on a
  // DST-change day it differs from the offset at UTC midnight).
  const [y, m, d] = civil.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  let s = guess - tzOffsetMs(new Date(guess), timeZone);
  for (let i = 0; i < 3; i += 1) {
    const next = guess - tzOffsetMs(new Date(s), timeZone);
    if (next === s) break;
    s = next;
  }
  if (isFirstInstantOf(s, civil, timeZone)) return new Date(s).toISOString();
  // Local midnight does not exist (a DST jump AT 00:00, e.g. America/Santiago,
  // America/Havana): the day starts at the transition. Civil dates never go
  // backwards across a day boundary, so binary-search the first instant on or
  // after `civil` between guess − 15 h (still the day before in every zone)
  // and guess + 15 h (already that day in every zone). Transitions fall on
  // whole seconds, so 1 s resolution is exact.
  let lo = guess - 15 * 3_600_000;
  let hi = guess + 15 * 3_600_000;
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
    if ((civilDate(new Date(mid), timeZone) as string) >= civil) hi = mid;
    else lo = mid;
  }
  return new Date(hi).toISOString();
}

/** True when `ms` is on `civil` and the millisecond before it is not. */
function isFirstInstantOf(ms: number, civil: string, timeZone: string): boolean {
  return civilDate(new Date(ms), timeZone) === civil && civilDate(new Date(ms - 1), timeZone) !== civil;
}

/**
 * End of the civil day in the timezone: the LAST millisecond of that day
 * (start of the next day − 1 ms), so `civilDate(endOfCivilDayIso(d)) === d`.
 * This is the stored encoding for calendar deadlines (ARCHITECTURE.md §1) and
 * an INCLUSIVE bound — compare with `<=`. For an exclusive bound use
 * `startOfCivilDayIso(addCivilDays(civil, 1))`.
 */
export function endOfCivilDayIso(civil: string, timeZone = DEFAULT_TIMEZONE): string {
  return new Date(Date.parse(startOfCivilDayIso(addCivilDays(civil, 1), timeZone)) - 1).toISOString();
}

/** Offset of `timeZone` from UTC at instant `date`, in ms (positive east of UTC). */
export function tzOffsetMs(date: Date, timeZone = DEFAULT_TIMEZONE): number {
  const parts = cachedFormat(
    "offset",
    timeZone,
    () => ({ timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    "en-US",
  ).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Civil week containing `civil`, starting on `weekStartsOn` (0 = Sunday …
 * 6 = Saturday; default 1 = Monday, organisation_settings.week_starts_on).
 * Returns [startCivil, endCivilExclusive].
 */
export function civilWeekRange(civil: string, weekStartsOn = 1): [string, string] {
  const [y, m, d] = civil.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  const first = ((Math.trunc(weekStartsOn) % 7) + 7) % 7;
  const start = addCivilDays(civil, -((dow - first + 7) % 7));
  return [start, addCivilDays(start, 7)];
}

/** Civil month containing `civil`. Returns [startCivil, endCivilExclusive]. */
export function civilMonthRange(civil: string): [string, string] {
  const [y, m] = civil.split("-").map(Number);
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return [start, next];
}

export type RangePreset = "today" | "this_week" | "this_month" | "last_month" | "last_7_days" | "last_30_days" | "custom";

/**
 * Resolves a reporting range preset to ISO instant bounds [startIso, endIsoExclusive].
 * `opts.weekStartsOn` (organisation_settings.week_starts_on, default Monday)
 * decides where "this_week" starts.
 */
export function resolveRange(
  preset: RangePreset,
  timeZone = DEFAULT_TIMEZONE,
  custom?: { from?: string | null; to?: string | null },
  now: Date = new Date(),
  opts: { weekStartsOn?: number } = {},
): { from: string; to: string; label: string } {
  const today = todayCivil(timeZone, now);
  let start = today;
  let endExcl = addCivilDays(today, 1);
  let label = "Today";
  switch (preset) {
    case "this_week": {
      [start, endExcl] = civilWeekRange(today, opts.weekStartsOn ?? 1);
      label = "This week";
      break;
    }
    case "this_month": {
      [start, endExcl] = civilMonthRange(today);
      label = "This month";
      break;
    }
    case "last_month": {
      const [thisStart] = civilMonthRange(today);
      const prev = addCivilDays(thisStart, -1);
      [start, endExcl] = civilMonthRange(prev);
      label = "Last month";
      break;
    }
    case "last_7_days": {
      start = addCivilDays(today, -6);
      label = "Last 7 days";
      break;
    }
    case "last_30_days": {
      start = addCivilDays(today, -29);
      label = "Last 30 days";
      break;
    }
    case "custom": {
      start = custom?.from && /^\d{4}-\d{2}-\d{2}$/.test(custom.from) ? custom.from : addCivilDays(today, -29);
      const toCivil = custom?.to && /^\d{4}-\d{2}-\d{2}$/.test(custom.to) ? custom.to : today;
      endExcl = addCivilDays(toCivil, 1);
      label = `${formatDate(start, timeZone)} – ${formatDate(toCivil, timeZone)}`;
      break;
    }
    default:
      break;
  }
  return { from: startOfCivilDayIso(start, timeZone), to: startOfCivilDayIso(endExcl, timeZone), label };
}

// ---------- Formatting ----------

/** Machine-friendly local timestamp "YYYY-MM-DD HH:mm" (24h) in the timezone — CSV exports. */
export function localDateTimeString(value: DateInput, timeZone = DEFAULT_TIMEZONE): string | null {
  const d = toDate(value);
  if (!d) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

export function formatDate(value: DateInput, timeZone = DEFAULT_TIMEZONE): string {
  const d = toDate(value);
  if (!d) return "—";
  // A bare civil date (YYYY-MM-DD) should format as that date regardless of tz.
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, dd] = value.split("-").map(Number);
    return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
      new Date(Date.UTC(y, m - 1, dd)),
    );
  }
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone }).format(d);
}

export function formatDateShort(value: DateInput, timeZone = DEFAULT_TIMEZONE): string {
  const d = toDate(value);
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", timeZone }).format(d);
}

export function formatTime(value: DateInput, timeZone = DEFAULT_TIMEZONE): string {
  const d = toDate(value);
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).format(d);
}

export function formatDateTime(value: DateInput, timeZone = DEFAULT_TIMEZONE): string {
  const d = toDate(value);
  if (!d) return "—";
  return `${formatDate(d, timeZone)}, ${formatTime(d, timeZone)}`;
}

export function formatWeekday(value: DateInput, timeZone = DEFAULT_TIMEZONE): string {
  const d = toDate(value);
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-AU", { weekday: "short", timeZone }).format(d);
}

/** "3h ago", "in 2d", "just now" */
export function formatRelative(value: DateInput, now: Date = new Date()): string {
  const d = toDate(value);
  if (!d) return "—";
  const diff = d.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const future = diff > 0;
  const fmt = (n: number, unit: string) => (future ? `in ${n}${unit}` : `${n}${unit} ago`);
  if (abs < 45_000) return "just now";
  if (abs < 3_600_000) return fmt(Math.round(abs / 60_000), "m");
  if (abs < 86_400_000) return fmt(Math.round(abs / 3_600_000), "h");
  if (abs < 30 * 86_400_000) return fmt(Math.round(abs / 86_400_000), "d");
  if (abs < 365 * 86_400_000) return fmt(Math.round(abs / (30 * 86_400_000)), "mo");
  return fmt(Math.round(abs / (365 * 86_400_000)), "y");
}

/** "2d 4h", "35m", "1h 05m" — for durations in ms. */
export function formatDuration(ms: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return opts.compact ? `${days}d` : `${days}d ${hours % 24}h`;
  if (hours > 0) return opts.compact ? `${hours}h` : `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

/** Human "Due today" / "Due tomorrow" / "Overdue by 3d" / "Due in 5d" / "Due 14 Sep". */
export function describeDue(due: DateInput, timeZone = DEFAULT_TIMEZONE, now: Date = new Date()): {
  label: string;
  tone: "overdue" | "today" | "soon" | "later" | "none";
} {
  const r = daysRemaining(due, timeZone, now);
  if (r === null) return { label: "No due date", tone: "none" };
  if (r < 0) return { label: `Overdue by ${-r}d`, tone: "overdue" };
  if (r === 0) return { label: "Due today", tone: "today" };
  if (r === 1) return { label: "Due tomorrow", tone: "soon" };
  if (r <= 3) return { label: `Due in ${r}d`, tone: "soon" };
  return { label: `Due ${formatDateShort(due, timeZone)}`, tone: "later" };
}
