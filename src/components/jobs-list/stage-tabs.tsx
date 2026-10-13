import Link from "next/link";
import { STAGE_META, STAGE_TABS, type Stage } from "@/lib/stages";
import { STAGE_TONE_CLASSES } from "@/lib/constants";
import type { StageCounts, StageFilter } from "@/lib/types";
import { cn } from "@/lib/utils";
import { jobsHref, type JobsUrlState } from "./params";

export interface StageTabsProps {
  state: JobsUrlState;
  counts: StageCounts;
  className?: string;
}

interface Tab {
  key: StageFilter;
  label: string;
  count: number;
  dot: string | null;
}

/**
 * The stage tabs of the Jobs page (docs/SIMPLIFICATION-PLAN.md §4):
 * All active · Needs editor · With editor · Ready to check · Changes asked · Done.
 * Plain links (shareable URLs, no JS); counts follow the search / editor / client filters.
 * Cancelled is not a tab — it is the "Show cancelled" filter.
 */
export function StageTabs({ state, counts, className }: StageTabsProps) {
  const tabs: Tab[] = [
    { key: "all_active", label: "All active", count: counts.allActive, dot: null },
    ...STAGE_TABS.map((s: Stage) => ({ key: s as StageFilter, label: STAGE_META[s].label, count: counts.byStage[s], dot: STAGE_TONE_CLASSES[STAGE_META[s].tone].dot })),
  ];
  const current: StageFilter = state.stage === "cancelled" ? "all_active" : state.stage;
  return (
    <nav aria-label="Stages" className={cn("-mb-px flex items-center gap-1 overflow-x-auto border-b border-border scrollbar-none", className)}>
      {tabs.map((tab) => {
        const selected = tab.key === current;
        return (
          <Link
            key={tab.key}
            href={jobsHref(state, { stage: tab.key, cursor: undefined, view: "list" })}
            aria-current={selected ? "page" : undefined}
            data-state={selected ? "active" : "inactive"}
            className={cn(
              "relative inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-1 text-sm font-medium transition-colors focus-ring rounded-sm",
              "mx-2 first:ml-0",
              selected ? "border-accent text-ink" : "border-transparent text-ink-muted hover:text-ink",
            )}
          >
            {tab.dot ? <span aria-hidden="true" className={cn("size-1.5 rounded-full", tab.dot)} /> : null}
            {tab.label}
            <span
              className={cn(
                "ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-2xs font-semibold numeric",
                selected ? "bg-accent-soft text-accent-ink" : "bg-surface-muted text-ink-muted",
              )}
            >
              {tab.count}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
