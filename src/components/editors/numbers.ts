import type { EditorPeriodKey } from "@/lib/types";

/**
 * The five plain numbers of the Editors page (docs/SIMPLIFICATION-PLAN.md §7) and the one-line
 * explanation each shows on hover / tap. The words are the plan's; nothing here says turnaround,
 * utilisation, capacity hours or bands.
 */
export type EditorNumberKey = "onDesk" | "lateNow" | "finished" | "onTimePct" | "neededChangesPct";

export interface EditorNumberMeta {
  key: EditorNumberKey;
  label: string;
  help: string;
  /** Percentages render as "93%". */
  percent: boolean;
  /** Which way is good news for the "vs last period" arrow (null = neither). */
  goodWhen: "up" | "down" | null;
}

export const EDITOR_NUMBERS: readonly EditorNumberMeta[] = [
  { key: "onDesk", label: "On their desk", help: "Jobs they have right now: With editor and Changes asked.", percent: false, goodWhen: null },
  { key: "lateNow", label: "Late now", help: "Of the jobs on their desk, how many are past the due date.", percent: false, goodWhen: "down" },
  { key: "finished", label: "Finished", help: "Jobs you approved in this period.", percent: false, goodWhen: "up" },
  { key: "onTimePct", label: "On time", help: "Of the finished jobs, the share they first sent for checking on or before the due date.", percent: true, goodWhen: "up" },
  { key: "neededChangesPct", label: "Needed changes", help: "Of the finished jobs, the share where you asked for changes at least once.", percent: true, goodWhen: "down" },
];

export const NOT_ENOUGH_LABEL = "Not enough jobs yet";

/** "vs last month" / "vs the 3 months before" for the editor page arrows. */
export function previousPeriodLabel(period: EditorPeriodKey): string {
  switch (period) {
    case "this_month":
      return "vs last month";
    case "last_month":
      return "vs the month before";
    case "last_3_months":
      return "vs the 3 months before";
  }
}

/** "93%" or the Not-enough note. */
export function formatRate(pct: number | null, notEnough: boolean): string {
  if (notEnough || pct === null) return NOT_ENOUGH_LABEL;
  return `${Math.round(pct)}%`;
}

/** "4 of 6" when a usual capacity is set, else "4". */
export function formatOnDesk(onDesk: number, usualCapacity: number | null): string {
  return usualCapacity !== null ? `${onDesk} of ${usualCapacity}` : String(onDesk);
}
