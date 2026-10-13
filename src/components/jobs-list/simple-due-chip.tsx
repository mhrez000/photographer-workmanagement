import { AlarmClock, CalendarClock, CalendarX2 } from "lucide-react";
import type { SimpleDue } from "@/lib/types";
import { cn } from "@/lib/utils";
import { dueWords, type DueTone } from "./format";

export interface SimpleDueChipProps {
  due: SimpleDue;
  /** The job is in an active stage (Done / Cancelled are never late). */
  active: boolean;
  className?: string;
}

const TONES: Record<DueTone, string> = {
  late: "bg-danger-soft text-danger-fg font-semibold",
  today: "bg-attention-soft text-attention-fg font-medium",
  soon: "bg-surface-muted text-ink-secondary",
  later: "bg-surface-muted text-ink-secondary",
  quiet: "text-ink-muted",
  none: "text-ink-subtle",
};

/**
 * The due chip of the simplified UI (docs/SIMPLIFICATION-PLAN.md §5): "2 days late" in red,
 * "Due today", "Due tomorrow", "Due Fri", "Due 14 Oct". Driven by the query's `SimpleDue`
 * (organisation-day arithmetic), so a row never disagrees with the Late filter.
 */
export function SimpleDueChip({ due, active, className }: SimpleDueChipProps) {
  const { label, tone } = dueWords(due, active);
  const Icon = tone === "late" ? CalendarX2 : tone === "today" ? AlarmClock : CalendarClock;
  return (
    <span
      data-tone={tone}
      className={cn("inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs numeric", TONES[tone], className)}
      title={due.civilDate ? `Due ${due.civilDate}` : undefined}
    >
      {tone !== "none" ? <Icon aria-hidden="true" className="size-3" /> : null}
      {label}
    </span>
  );
}
