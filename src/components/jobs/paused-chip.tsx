import * as React from "react";
import { Pause } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, type DateInput } from "@/lib/dates";
import { cn } from "@/lib/utils";

export interface PausedChipProps {
  pausedAt?: DateInput;
  timeZone?: string;
  /** Icon only (kanban cards). */
  compact?: boolean;
  className?: string;
}

/** "Paused" chip for jobs an editor has put on hold (spec §2). */
export function PausedChip({ pausedAt, timeZone, compact = false, className }: PausedChipProps) {
  const title = pausedAt ? `Paused since ${formatDateTime(pausedAt, timeZone)}` : "Paused";
  return (
    <Badge variant="warning" size="sm" title={title} className={cn(compact && "px-1.5", className)}>
      <Pause aria-hidden="true" />
      {compact ? <span className="sr-only">Paused</span> : "Paused"}
    </Badge>
  );
}
