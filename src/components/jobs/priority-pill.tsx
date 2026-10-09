import * as React from "react";
import { PriorityBadge } from "@/components/ui/badge";
import type { Priority } from "@/lib/constants";

export interface PriorityPillProps {
  priority: Priority;
  size?: "sm" | "md";
  /** Signal bars only (dense tables); the label moves to the tooltip. */
  compact?: boolean;
  /** Render nothing for "normal" so only exceptions draw the eye. */
  quietNormal?: boolean;
  className?: string;
}

/** Job priority pill using the priority tokens (4-step signal bars + label). */
export function PriorityPill({ priority, size = "sm", compact = false, quietNormal = false, className }: PriorityPillProps) {
  if (quietNormal && priority === "normal") return null;
  return <PriorityBadge priority={priority} size={size} compact={compact} className={className} />;
}
