import * as React from "react";
import { RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn, pluralise } from "@/lib/utils";

export interface RevisionCountProps {
  count: number;
  /** Render "R0" instead of nothing when there were no revisions. */
  showZero?: boolean;
  /** Add the rotate icon. */
  icon?: boolean;
  className?: string;
}

/** Compact revision badge ("R2"): neutral at 1, warning at 2, danger from 3. */
export function RevisionCount({ count, showZero = false, icon = false, className }: RevisionCountProps) {
  if (count <= 0 && !showZero) return null;
  const variant = count <= 0 ? "outline" : count === 1 ? "neutral" : count === 2 ? "warning" : "danger";
  const label = count <= 0 ? "No revisions" : pluralise(count, "revision");
  return (
    <Badge variant={variant} size="sm" title={label} aria-label={label} className={cn("numeric font-semibold", className)}>
      {icon ? <RotateCcw aria-hidden="true" /> : null}R{count}
    </Badge>
  );
}
