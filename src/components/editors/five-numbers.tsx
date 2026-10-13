import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type { EditorDetail, EditorNumberDelta } from "@/lib/types";
import { cn } from "@/lib/utils";
import { NumberLabel } from "./number-label";
import { EDITOR_NUMBERS, formatOnDesk, formatRate, previousPeriodLabel, type EditorNumberMeta } from "./numbers";

export interface FiveNumbersProps {
  detail: EditorDetail;
}

function DeltaArrow({ delta, meta, periodLabel }: { delta: EditorNumberDelta; meta: EditorNumberMeta; periodLabel: string }) {
  if (delta.delta === null) return null;
  const d = Math.round(delta.delta);
  const direction = d > 0 ? "up" : d < 0 ? "down" : "flat";
  const good = meta.goodWhen === null || direction === "flat" ? null : direction === meta.goodWhen;
  const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus;
  const text = direction === "flat" ? "Same" : `${d > 0 ? "+" : "−"}${Math.abs(d)}${meta.percent ? " pts" : ""}`;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-sm px-1.5 py-0.5 text-2xs font-medium numeric",
        good === null ? "bg-surface-muted text-ink-muted" : good ? "bg-success-soft text-success-fg" : "bg-danger-soft text-danger-fg",
      )}
      title={`${text} ${periodLabel}`}
    >
      <Icon aria-hidden="true" className="size-3" />
      {text}
      <span className="sr-only"> {periodLabel}</span>
    </span>
  );
}

/**
 * The editor page's five numbers (docs/SIMPLIFICATION-PLAN.md §7), each with a small "vs last month"
 * arrow. "On their desk" and "Late now" are what is true RIGHT NOW (there is no "last month" value to
 * compare against), so their arrow row says "Right now" instead of standing empty.
 */
/**
 * Tooltip side per tile so the bubble never grows past the viewport: the grid is 2 columns on phones,
 * 3 from `sm`, 5 from `lg`, and the last tile spans the phone row. Right-hand tiles grow leftwards.
 */
const TOOLTIP_ALIGN: readonly string[] = [
  "",
  "right-0 left-auto sm:left-0 sm:right-auto",
  "sm:right-0 sm:left-auto lg:left-0 lg:right-auto",
  "right-0 left-auto sm:left-0 sm:right-auto",
  "lg:right-0 lg:left-auto",
];

export function FiveNumbers({ detail }: FiveNumbersProps) {
  const { numbers, deltas, usualCapacity, full } = detail;
  const periodLabel = previousPeriodLabel(detail.period.period);

  const valueOf = (meta: EditorNumberMeta): { text: string; tone: string; small: boolean } => {
    switch (meta.key) {
      case "onDesk":
        return { text: formatOnDesk(numbers.onDesk, usualCapacity), tone: full ? "text-attention-fg" : "text-ink", small: false };
      case "lateNow":
        return { text: String(numbers.lateNow), tone: numbers.lateNow > 0 ? "text-danger-fg" : "text-ink", small: false };
      case "finished":
        return { text: String(numbers.finished), tone: "text-ink", small: false };
      case "onTimePct":
        return { text: formatRate(numbers.onTimePct, numbers.notEnough), tone: "text-ink", small: numbers.notEnough };
      case "neededChangesPct":
        return { text: formatRate(numbers.neededChangesPct, numbers.notEnough), tone: "text-ink", small: numbers.notEnough };
    }
  };

  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {EDITOR_NUMBERS.map((meta, index) => {
        const v = valueOf(meta);
        const delta = deltas[meta.key];
        return (
          <div key={meta.key} className="flex min-w-0 flex-col rounded-md border border-border bg-surface px-3.5 py-3 last:col-span-2 sm:last:col-span-1">
            <dt className="eyebrow">
              <NumberLabel meta={meta} align="start" tooltipClassName={TOOLTIP_ALIGN[index]} />
            </dt>
            <dd className={cn("mt-1.5 leading-7 tracking-tight", v.small ? "text-sm text-ink-subtle" : cn("text-xl font-semibold numeric", v.tone))}>{v.text}</dd>
            <dd className="mt-1 flex min-h-5 items-center gap-1.5 text-xs text-ink-muted">
              {delta.previous === null && delta.current !== null && (meta.key === "onDesk" || meta.key === "lateNow") ? (
                <span className="truncate">Right now</span>
              ) : (
                <>
                  <DeltaArrow delta={delta} meta={meta} periodLabel={periodLabel} />
                  <span className="truncate">{delta.delta !== null ? periodLabel : `No ${periodLabel.replace(/^vs /, "")} to compare`}</span>
                </>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
