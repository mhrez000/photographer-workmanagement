import * as React from "react";
import type { WorkloadBand } from "@/lib/constants";
import { cn } from "@/lib/utils";

const FILL: Record<WorkloadBand, string> = {
  healthy: "bg-accent",
  near_capacity: "bg-attention",
  overloaded: "bg-danger",
};

export interface CapacityBarProps {
  /** Workload score ÷ capacity (0..n). */
  ratio: number;
  band: WorkloadBand;
  /** Show the % figure next to the bar. */
  showValue?: boolean;
  /** Capacity hours/week for the accessible label + tooltip. */
  capacityHours?: number;
  /** Weighted workload hours (score). */
  loadHours?: number;
  className?: string;
}

/**
 * Load vs capacity. The track is 100 % capacity; anything above spills into
 * a hatched overflow segment so "over capacity" is visible at a glance.
 */
export function CapacityBar({ ratio, band, showValue = true, capacityHours, loadHours, className }: CapacityBarProps) {
  const safe = Number.isFinite(ratio) ? Math.max(0, ratio) : 0;
  const pct = Math.round(safe * 100);
  const fill = Math.min(safe, 1) * 100;
  const over = safe > 1;
  const title =
    capacityHours !== undefined && loadHours !== undefined
      ? `${loadHours.toFixed(1)}h weighted load of ${capacityHours}h/week capacity (${pct}%)`
      : `${pct}% of capacity`;
  return (
    <div className={cn("flex min-w-24 items-center gap-2", className)} title={title}>
      <div
        role="meter"
        aria-label="Capacity used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(pct, 100)}
        aria-valuetext={title}
        className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-surface-muted"
      >
        <div className={cn("h-full rounded-full transition-[width] duration-(--motion-slow) ease-out-soft", FILL[band])} style={{ width: `${fill}%` }} />
        {over ? (
          <div
            aria-hidden="true"
            className="absolute inset-y-0 right-0 w-1.5 bg-[repeating-linear-gradient(135deg,var(--danger)_0_2px,transparent_2px_4px)]"
          />
        ) : null}
      </div>
      {showValue ? <span className={cn("w-10 text-right text-xs numeric", over ? "font-medium text-danger-fg" : "text-ink-muted")}>{pct}%</span> : null}
    </div>
  );
}
