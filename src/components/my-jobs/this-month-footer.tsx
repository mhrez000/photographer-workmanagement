import { formatRate } from "@/components/editors/numbers";
import type { MyJobsFooter } from "@/lib/types";
import { pluralise } from "@/lib/utils";

export interface ThisMonthFooterProps {
  footer: MyJobsFooter;
}

/**
 * "This month: 14 finished · 93% on time · 7% needed changes" (docs/SIMPLIFICATION-PLAN.md §6) — the
 * editor's own numbers, measured exactly the way the owner sees them on the Editors page.
 */
export function ThisMonthFooter({ footer }: ThisMonthFooterProps) {
  const parts: string[] = [`${pluralise(footer.finished, "job")} finished`];
  if (footer.notEnough) {
    parts.push("on-time and changes numbers appear after 5 finished jobs");
  } else {
    parts.push(`${formatRate(footer.onTimePct, false)} on time`);
    parts.push(`${formatRate(footer.neededChangesPct, false)} needed changes`);
  }
  return (
    <footer className="rounded-lg border border-border bg-surface-sunken/60 px-4 py-3 text-sm text-ink-secondary">
      <span className="font-medium text-ink">This month:</span> {parts.join(" · ")}
      <span className="block text-xs text-ink-muted sm:ml-2 sm:inline">On time means you sent the job for checking by its due date; checking time never counts against you.</span>
    </footer>
  );
}
