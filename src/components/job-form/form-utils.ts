import { civilDate } from "@/lib/dates";
import type { JobTypeView } from "@/lib/types";

/** ISO instant → the `YYYY-MM-DD` value a date input shows (in the org timezone). */
export function toCivilInput(value: string | null | undefined, timeZone: string): string {
  return value ? (civilDate(value, timeZone) ?? "") : "";
}

/** Date input value → API value (`YYYY-MM-DD` civil date, or null to clear). */
export function fromCivilInput(value: string): string | null {
  return value.trim() ? value.trim() : null;
}

/** Parses an "estimated hours" text box; "" → null, invalid → NaN. */
export function parseHours(value: string): number | null {
  const v = value.trim().replace(",", ".");
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
}

export function hoursError(value: string): string | null {
  const n = parseHours(value);
  if (n === null) return null;
  if (Number.isNaN(n)) return "Enter a number of hours, like 2.5";
  if (n < 0 || n > 1000) return "Between 0 and 1000 hours";
  return null;
}

/** "123 Smith Street · Twilight": the default job name from project + job type. */
export function suggestJobName(projectName: string | null | undefined, jobType: Pick<JobTypeView, "name"> | null | undefined): string {
  const parts = [projectName?.trim(), jobType?.name.trim()].filter((p): p is string => Boolean(p));
  return parts.join(" · ");
}

/** Soft (non-blocking) date sanity checks, as hints under the dates. */
export function dateWarnings(d: { shootDate: string; dueDate: string; reviewDueDate: string; deliveryDueDate: string }): string[] {
  const out: string[] = [];
  if (d.shootDate && d.dueDate && d.dueDate < d.shootDate) out.push("The editing deadline is before the shoot.");
  if (d.dueDate && d.reviewDueDate && d.reviewDueDate < d.dueDate) out.push("The review deadline is before the editing deadline.");
  const before = d.reviewDueDate || d.dueDate;
  if (before && d.deliveryDueDate && d.deliveryDueDate < before) out.push("Delivery is due before the work would be reviewed.");
  return out;
}

/** Maps API field errors (first message each) onto our field keys. */
export function pickErrors(fieldErrors: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fieldErrors)) if (v?.[0]) out[k] = v[0];
  return out;
}

