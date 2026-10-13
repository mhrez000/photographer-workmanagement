import { formatDateShort, formatWeekday } from "@/lib/dates";
import type { SimpleDue } from "@/lib/types";

export type DueTone = "late" | "today" | "soon" | "later" | "none";

/**
 * The due words used on My jobs and Editors cards (docs/SIMPLIFICATION-PLAN.md §6): "Due today",
 * "Due tomorrow", "Due Fri", "Due 14 Oct", "1 day late" — never "overdue by 2d".
 */
export function dueText(due: SimpleDue, timeZone: string): { label: string; tone: DueTone } {
  const d = due.daysFromToday;
  if (d === null || !due.dueDate) return { label: "No due date", tone: "none" };
  if (due.late) {
    const n = Math.max(1, -d);
    return { label: `${n} ${n === 1 ? "day" : "days"} late`, tone: "late" };
  }
  if (d < 0) return { label: `Was due ${formatDateShort(due.dueDate, timeZone)}`, tone: "none" };
  if (d === 0) return { label: "Due today", tone: "today" };
  if (d === 1) return { label: "Due tomorrow", tone: "soon" };
  if (d <= 6) return { label: `Due ${formatWeekday(due.dueDate, timeZone)}`, tone: "soon" };
  return { label: `Due ${formatDateShort(due.dueDate, timeZone)}`, tone: "later" };
}

export const DUE_TONE_CLASS: Record<DueTone, string> = {
  late: "text-danger-fg font-medium",
  today: "text-attention-fg font-medium",
  soon: "text-ink-secondary",
  later: "text-ink-muted",
  none: "text-ink-subtle",
};
