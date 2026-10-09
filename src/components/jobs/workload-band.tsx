import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { WORKLOAD_BAND_META, type WorkloadBand as WorkloadBandKey } from "@/lib/constants";
import type { WorkloadRow } from "@/lib/types";
import { cn, formatPercent } from "@/lib/utils";

const BAND_VARIANT: Record<WorkloadBandKey, "success" | "warning" | "danger"> = {
  healthy: "success",
  near_capacity: "warning",
  overloaded: "danger",
};

const REASON_TEXT: Record<WorkloadRow["bandReason"], string | null> = {
  ratio: null,
  max_active: "At the maximum number of active jobs",
  overdue_cap: "Too many overdue jobs",
  inactive: "User is deactivated",
};

export interface WorkloadBandProps {
  band: WorkloadBandKey;
  /** Score ÷ capacity (0..n) — shown as % in the label/tooltip. */
  ratio?: number | null;
  /** Why the band was forced (WorkloadRow.bandReason). */
  reason?: WorkloadRow["bandReason"] | null;
  /** Show the text label next to the emoji (default true). */
  showLabel?: boolean;
  /** Append the ratio as a % after the label. */
  showRatio?: boolean;
  size?: "sm" | "md";
  className?: string;
}

/** 🟢 Healthy / 🟡 Near capacity / 🔴 Overloaded — matches WORKLOAD_BAND_META. */
export function WorkloadBand({ band, ratio, reason, showLabel = true, showRatio = false, size = "sm", className }: WorkloadBandProps) {
  const meta = WORKLOAD_BAND_META[band];
  const reasonText = reason ? REASON_TEXT[reason] : null;
  const pct = ratio !== undefined && ratio !== null && Number.isFinite(ratio) ? formatPercent(ratio) : null;
  const title = [meta.label, pct ? `${pct} of capacity` : null, reasonText].filter(Boolean).join(" · ");

  if (!showLabel) {
    return (
      <span role="img" aria-label={title} title={title} className={cn("inline-flex text-sm leading-none", className)}>
        {meta.emoji}
      </span>
    );
  }

  return (
    <Badge variant={BAND_VARIANT[band]} size={size} title={title} data-band={band} className={className}>
      <span aria-hidden="true" className="text-[0.85em] leading-none">
        {meta.emoji}
      </span>
      {meta.label}
      {showRatio && pct ? <span className="numeric opacity-75">{pct}</span> : null}
      {reasonText ? <span className="sr-only">({reasonText})</span> : null}
    </Badge>
  );
}
