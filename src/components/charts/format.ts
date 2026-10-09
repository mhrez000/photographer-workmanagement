/**
 * Chart value / axis formatters. Pure and serialisable by *name* so server
 * components can pick a format ("duration", "percent", …) for a client chart
 * without passing functions across the boundary.
 */

export type ValueFormat = "count" | "percent" | "ratio" | "duration" | "hours" | "decimal";
export type DateFormat = "day" | "week" | "month" | "none";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2d 4h" / "6h" / "35m" from seconds. */
export function formatSecondsShort(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes < 1 ? "<1m" : `${minutes}m`;
  const hours = seconds / 3600;
  if (hours < 24) return hours < 10 ? `${hours.toFixed(1).replace(/\.0$/, "")}h` : `${Math.round(hours)}h`;
  const days = Math.floor(hours / 24);
  const rem = Math.floor(hours - days * 24);
  return rem === 0 || days >= 10 ? `${days}d` : `${days}d ${rem}h`;
}

/** Formats a chart value. `percent` expects 0..100; `ratio` expects 0..1. */
export function formatValue(value: number | null | undefined, format: ValueFormat = "count"): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  switch (format) {
    case "percent":
      return `${Math.round(value)}%`;
    case "ratio":
      return `${Math.round(value * 100)}%`;
    case "duration":
      return formatSecondsShort(value);
    case "hours":
      return `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)}h`;
    case "decimal":
      return value.toFixed(1);
    default:
      return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 1 }).format(value);
  }
}

/** Axis tick for a civil date "YYYY-MM-DD" (already in the org timezone). */
export function formatCivilTick(civil: string, format: DateFormat = "day"): string {
  if (format === "none") return civil;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(civil);
  if (!m) return civil;
  const month = MONTHS[Number(m[2]) - 1] ?? m[2];
  if (format === "month") return `${month} ${m[1].slice(2)}`;
  return `${Number(m[3])} ${month}`;
}

/** Tooltip heading for a civil date bucket. */
export function formatCivilLabel(civil: string, format: DateFormat = "day"): string {
  if (format === "none") return civil;
  const tick = formatCivilTick(civil, format === "month" ? "month" : "day");
  return format === "week" ? `Week of ${tick}` : tick;
}
