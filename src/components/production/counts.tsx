import * as React from "react";
import { Progress } from "@/components/ui/progress";
import type { JobCounts } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Completed / total as a slim bar with "4 of 9" (cancelled jobs are excluded upstream by the caller when needed). */
export function JobsDoneBar({ completed, total, className, label }: { completed: number; total: number; className?: string; label?: string }) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <Progress value={completed} max={Math.max(total, 1)} size="xs" tone={total > 0 && completed === total ? "success" : "accent"} label={label ?? "Jobs completed"} className="min-w-16 flex-1" />
      <span className="shrink-0 text-xs text-ink-muted numeric" title={`${pct}% complete`}>
        {completed}/{total}
      </span>
    </div>
  );
}

/** Inline open · overdue · due today · completed counts with semantic tones. */
export function CountsInline({ counts, className }: { counts: JobCounts; className?: string }) {
  if (counts.total === 0) return <span className={cn("text-xs text-ink-subtle", className)}>No jobs yet</span>;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted numeric", className)}>
      <span>
        <span className="font-medium text-ink">{counts.open}</span> open
      </span>
      {counts.overdue > 0 ? (
        <span className="text-danger-fg">
          <span className="font-semibold">{counts.overdue}</span> overdue
        </span>
      ) : null}
      {counts.dueToday > 0 ? (
        <span className="text-attention-fg">
          <span className="font-semibold">{counts.dueToday}</span> due today
        </span>
      ) : null}
      <span>
        <span className="font-medium text-ink">{counts.completed}</span> completed
      </span>
    </span>
  );
}

/** A count cell: muted zero, danger tone when `tone` is set and value > 0. */
export function CountCell({ value, tone }: { value: number; tone?: "danger" | "attention" }) {
  if (value === 0) return <span className="text-ink-subtle">0</span>;
  return (
    <span className={cn("font-medium", tone === "danger" ? "text-danger-fg" : tone === "attention" ? "text-attention-fg" : "text-ink")}>{value}</span>
  );
}
