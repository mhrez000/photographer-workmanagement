"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { formatValue, type ValueFormat } from "./format";

/** The subset of recharts tooltip-content props our tooltips read. */
export interface TooltipBaseProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
  label?: unknown;
}

export interface ChartTooltipRow {
  key: string;
  label: string;
  value: number | null;
  color: string;
  format: ValueFormat;
}

/** Hairline popover used by every chart tooltip (tabular numbers, colour keys). */
export function ChartTooltipBox({
  title,
  rows,
  footer,
  className,
}: {
  title?: React.ReactNode;
  rows: ChartTooltipRow[];
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none min-w-36 max-w-64 rounded-md border border-border bg-surface-raised px-3 py-2 text-xs shadow-pop",
        className,
      )}
    >
      {title ? <div className="mb-1.5 font-medium text-ink">{title}</div> : null}
      <ul className="flex flex-col gap-1">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-2">
            <span aria-hidden="true" className="size-2 shrink-0 rounded-[2px]" style={{ background: r.color }} />
            <span className="min-w-0 flex-1 truncate text-ink-secondary">{r.label}</span>
            <span className="numeric font-medium text-ink">{formatValue(r.value, r.format)}</span>
          </li>
        ))}
      </ul>
      {footer ? <div className="mt-1.5 border-t border-border pt-1.5 text-ink-muted">{footer}</div> : null}
    </div>
  );
}

/** Small HTML legend rendered above a chart (keeps typography consistent with the page). */
export function ChartLegend({
  items,
  className,
}: {
  items: { key: string; label: string; color: string; dashed?: boolean; swatch?: "line" | "box" }[];
  className?: string;
}) {
  if (items.length <= 1) return null;
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted", className)}>
      {items.map((i) => (
        <li key={i.key} className="inline-flex items-center gap-1.5">
          {i.swatch === "box" ? (
            <span aria-hidden="true" className="inline-block size-2.5 rounded-[2px]" style={{ background: i.color }} />
          ) : (
            <span
              aria-hidden="true"
              className={cn("inline-block w-3.5", i.dashed ? "border-t-2 border-dashed" : "h-0.5 rounded-full")}
              style={i.dashed ? { borderColor: i.color } : { background: i.color }}
            />
          )}
          {i.label}
        </li>
      ))}
    </ul>
  );
}
