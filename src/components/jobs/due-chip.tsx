import * as React from "react";
import { AlarmClock, CalendarCheck2, CalendarClock, CalendarX2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { daysRemaining, describeDue, formatDateShort, formatDateTime, type DateInput } from "@/lib/dates";
import { cn } from "@/lib/utils";

export interface DueChipProps {
  /** ISO due instant (end of the civil day in org tz), or null. */
  due: DateInput;
  /** Organisation timezone — always pass `ctx.settings.timezone`. */
  timeZone: string;
  /** When set the job is finished: show completion instead of urgency. */
  completedAt?: DateInput;
  /** The editing deadline is already met (category ∈ DONE): never overdue / due today. */
  done?: boolean;
  /** Short labels for dense rows ("3d late", "Today", "Tmrw", "14 Sep"). */
  compact?: boolean;
  /** Prefix for screen readers / titles ("Review due", "Delivery due"). */
  kind?: string;
  className?: string;
}

function compactLabel(due: DateInput, timeZone: string): string {
  const r = daysRemaining(due, timeZone);
  if (r === null) return "—";
  if (r < 0) return `${-r}d late`;
  if (r === 0) return "Today";
  if (r === 1) return "Tmrw";
  if (r <= 6) return `${r}d`;
  return formatDateShort(due, timeZone);
}

/**
 * Due-date chip using `describeDue` in the org timezone: overdue = danger,
 * due today = attention, due soon = warning, later = neutral, none = muted.
 */
export function DueChip({ due, timeZone, completedAt, done = false, compact = false, kind = "Due", className }: DueChipProps) {
  if (completedAt) {
    return (
      <Badge
        variant="success"
        size="sm"
        title={`Completed ${formatDateTime(completedAt, timeZone)}`}
        className={cn("numeric", className)}
      >
        <CalendarCheck2 aria-hidden="true" />
        {compact ? formatDateShort(completedAt, timeZone) : `Done ${formatDateShort(completedAt, timeZone)}`}
      </Badge>
    );
  }

  const info = describeDue(due, timeZone);
  if (info.tone === "none") {
    return (
      <span className={cn("inline-flex items-center gap-1 text-xs text-ink-subtle", className)}>
        {compact ? "—" : "No due date"}
      </span>
    );
  }

  const title = `${kind} ${formatDateTime(due, timeZone)}`;

  if (done) {
    return (
      <span title={title} className={cn("inline-flex items-center gap-1 text-xs text-ink-muted numeric", className)}>
        <CalendarClock aria-hidden="true" className="size-3" />
        {formatDateShort(due, timeZone)}
      </span>
    );
  }

  const label = compact ? compactLabel(due, timeZone) : info.label;
  const variant =
    info.tone === "overdue" ? "danger" : info.tone === "today" ? "attention" : info.tone === "soon" ? "warning" : "outline";
  const Icon = info.tone === "overdue" ? CalendarX2 : info.tone === "today" ? AlarmClock : CalendarClock;

  return (
    <Badge
      variant={variant}
      size="sm"
      title={title}
      data-tone={info.tone}
      className={cn("numeric", className)}
    >
      <Icon aria-hidden="true" />
      <span className="sr-only">{kind}: </span>
      {label}
    </Badge>
  );
}
