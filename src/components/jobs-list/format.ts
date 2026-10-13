/**
 * Plain-words formatting for the simplified screens (docs/SIMPLIFICATION-PLAN.md §4–§6).
 * Pure helpers, server-safe. Civil dates are "YYYY-MM-DD" in the organisation timezone.
 */
import { formatDateShort } from "@/lib/dates";
import type { SimpleDue } from "@/lib/types";

const CIVIL = /^\d{4}-\d{2}-\d{2}$/;

function civilToUtc(civil: string): Date | null {
  if (!CIVIL.test(civil)) return null;
  const [y, m, d] = civil.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** "Fri" for a civil date (no timezone shift: the civil day is already the org day). */
export function civilWeekday(civil: string): string {
  const d = civilToUtc(civil);
  return d ? new Intl.DateTimeFormat("en-AU", { weekday: "short", timeZone: "UTC" }).format(d) : "";
}

/** "14 Oct" for a civil date. */
export function civilDayMonth(civil: string): string {
  const d = civilToUtc(civil);
  return d ? new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", timeZone: "UTC" }).format(d) : "";
}

/** "Wednesday 14 October" for a civil date. */
export function civilLong(civil: string): string {
  const d = civilToUtc(civil);
  return d ? new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(d) : "";
}

/** Whole civil days from `today` to `civil` (negative = past). */
export function civilDaysFromToday(civil: string, today: string): number | null {
  const a = civilToUtc(civil);
  const b = civilToUtc(today);
  if (!a || !b) return null;
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

/** "Today" / "Tomorrow" / "Yesterday" / "Fri" (this week) / "14 Oct". */
export function relativeCivil(civil: string, today: string): string {
  const diff = civilDaysFromToday(civil, today);
  if (diff === null) return civilDayMonth(civil);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff < 7) return civilWeekday(civil);
  return civilDayMonth(civil);
}

export type DueTone = "late" | "today" | "soon" | "later" | "none" | "quiet";

/**
 * The due chip words (plan §5): "2 days late" (red) · "Due today" · "Due tomorrow" · "Due Fri" ·
 * "Due 14 Oct". Done / cancelled jobs show the date quietly and are never late.
 */
export function dueWords(due: SimpleDue, active: boolean): { label: string; tone: DueTone } {
  if (!due.civilDate) return { label: "No due date", tone: "none" };
  if (!active) return { label: `Due ${civilDayMonth(due.civilDate)}`, tone: "quiet" };
  const d = due.daysFromToday;
  if (due.late || (d !== null && d < 0)) {
    const n = Math.max(1, -(d ?? -1));
    return { label: `${n} ${n === 1 ? "day" : "days"} late`, tone: "late" };
  }
  if (d === 0) return { label: "Due today", tone: "today" };
  if (d === 1) return { label: "Due tomorrow", tone: "soon" };
  if (d !== null && d < 7) return { label: `Due ${civilWeekday(due.civilDate)}`, tone: "soon" };
  return { label: `Due ${civilDayMonth(due.civilDate)}`, tone: "later" };
}

/** "just now" · "5 min ago" · "3 h ago" · "2 days ago". */
export function agoWords(seconds: number): string {
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(seconds / 3600);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(seconds / 86_400);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** Seconds between two ISO instants (never negative). */
export function secondsBetween(from: string, to: string): number {
  return Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / 1000));
}

/** "sent 5 h ago" for a Ready-to-check card. */
export function sentWords(sentAt: string, now: string): string {
  return `sent ${agoWords(secondsBetween(sentAt, now))}`;
}

/** Short instant for list rows ("14 Oct"). */
export function shortDate(iso: string | null, timeZone: string): string {
  return iso ? formatDateShort(iso, timeZone) : "—";
}

/** The month of a civil date as "YYYY-MM". */
export function monthOf(civil: string): string {
  return civil.slice(0, 7);
}

/** First civil day of "YYYY-MM". */
export function monthStart(month: string): string {
  return `${month}-01`;
}

/** Shift "YYYY-MM" by `delta` months. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** "October 2026" for "YYYY-MM". */
export function monthTitle(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-AU", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A valid "YYYY-MM" from the URL, or the fallback. */
export function normaliseMonth(value: string | undefined, fallback: string): string {
  return value && MONTH.test(value) ? value : fallback;
}

/** "1 job" / "3 jobs". */
export function jobsWord(n: number): string {
  return `${n} ${n === 1 ? "job" : "jobs"}`;
}
