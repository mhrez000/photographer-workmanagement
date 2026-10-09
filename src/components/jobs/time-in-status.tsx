import * as React from "react";
import { Hourglass } from "lucide-react";
import { formatDateTime, formatDuration, type DateInput } from "@/lib/dates";
import { cn } from "@/lib/utils";

export interface TimeInStatusProps {
  /** Seconds in the current status (JobRow.timeInStatusSeconds); preferred when known. */
  seconds?: number | null;
  /** When the job entered the status (JobRow.statusEnteredAt) — used if `seconds` is missing. */
  since?: DateInput;
  /** Org timezone for the tooltip. */
  timeZone?: string;
  /** Hours after which the value turns attention-toned (stalled feel). */
  warnAfterHours?: number;
  /** Hours after which it turns danger-toned. */
  alertAfterHours?: number;
  /** "3d" instead of "3d 4h", no icon caption. */
  compact?: boolean;
  /** Prefix text ("in Review"); default none. */
  suffix?: string;
  className?: string;
}

function secondsSince(value: DateInput): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

/** "4h 12m in status" with an hourglass; tones up when a job sits too long. */
export function TimeInStatus({
  seconds,
  since,
  timeZone,
  warnAfterHours,
  alertAfterHours,
  compact = false,
  suffix,
  className,
}: TimeInStatusProps) {
  const secs = seconds ?? secondsSince(since);
  if (secs === null) return null;
  const hours = secs / 3600;
  const tone =
    alertAfterHours !== undefined && hours >= alertAfterHours
      ? "text-danger-fg"
      : warnAfterHours !== undefined && hours >= warnAfterHours
        ? "text-attention-fg"
        : "text-ink-muted";
  const title = since ? `In this status since ${formatDateTime(since, timeZone)}` : "Time in current status";
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 text-xs numeric", tone, className)}>
      <Hourglass aria-hidden="true" className="size-3 shrink-0" />
      <span suppressHydrationWarning>{formatDuration(secs * 1000, { compact })}</span>
      {suffix ? <span className="text-ink-subtle">{suffix}</span> : <span className="sr-only">in current status</span>}
    </span>
  );
}
