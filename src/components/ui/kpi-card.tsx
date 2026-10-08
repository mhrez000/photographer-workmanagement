import * as React from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "./skeleton";

export type KpiTone = "default" | "accent" | "attention" | "danger" | "success" | "info";

export interface KpiDelta {
  /** Preformatted delta text, e.g. "+12%" or "3 fewer". */
  value: string;
  direction?: "up" | "down" | "flat";
  /** Whether the movement is good news. Defaults from direction (up = positive). */
  sentiment?: "positive" | "negative" | "neutral";
}

export interface KpiCardProps extends Omit<React.ComponentPropsWithRef<"div">, "children"> {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Secondary line under the value ("of 42 active"). */
  sub?: React.ReactNode;
  delta?: KpiDelta;
  tone?: KpiTone;
  icon?: LucideIcon;
  /** Makes the whole card a link. */
  href?: string;
  loading?: boolean;
}

const toneStyles: Record<KpiTone, { card: string; value: string; icon: string }> = {
  default: { card: "", value: "text-ink", icon: "bg-surface-muted text-ink-muted" },
  accent: { card: "", value: "text-accent-ink", icon: "bg-accent-soft text-accent-ink" },
  attention: { card: "", value: "text-attention-fg", icon: "bg-attention-soft text-attention" },
  danger: { card: "", value: "text-danger-fg", icon: "bg-danger-soft text-danger" },
  success: { card: "", value: "text-success-fg", icon: "bg-success-soft text-success" },
  info: { card: "", value: "text-info-fg", icon: "bg-info-soft text-info" },
};

const sentimentClass = {
  positive: "text-success-fg bg-success-soft",
  negative: "text-danger-fg bg-danger-soft",
  neutral: "text-ink-muted bg-surface-muted",
} as const;

/** Dashboard metric tile: label, big tabular value, delta and sub-line. */
export function KpiCard({
  label,
  value,
  sub,
  delta,
  tone = "default",
  icon: Icon,
  href,
  loading = false,
  className,
  ...props
}: KpiCardProps) {
  const styles = toneStyles[tone];
  const sentiment =
    delta?.sentiment ?? (delta?.direction === "up" ? "positive" : delta?.direction === "down" ? "negative" : "neutral");
  const DeltaIcon = delta?.direction === "up" ? ArrowUpRight : delta?.direction === "down" ? ArrowDownRight : Minus;

  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <span className="eyebrow truncate">{label}</span>
        {Icon ? (
          <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-sm", styles.icon)}>
            <Icon aria-hidden="true" className="size-3.5" />
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        {loading ? (
          <Skeleton className="h-8 w-20" />
        ) : (
          <span className={cn("numeric text-3xl font-semibold leading-9 tracking-tight", styles.value)}>
            {value}
          </span>
        )}
        {delta && !loading ? (
          <span
            className={cn(
              "inline-flex h-5 items-center gap-0.5 rounded-full px-1.5 text-2xs font-medium numeric",
              sentimentClass[sentiment],
            )}
          >
            <DeltaIcon aria-hidden="true" className="size-3" />
            {delta.value}
          </span>
        ) : null}
      </div>
      {sub ? <div className="mt-1 text-sm text-ink-muted">{loading ? <Skeleton className="h-3 w-28" /> : sub}</div> : null}
    </>
  );

  const base = cn(
    "group/kpi relative flex flex-col rounded-lg border border-border bg-surface p-5 shadow-xs",
    styles.card,
    href &&
      "transition-[box-shadow,border-color] duration-(--motion-base) ease-out-soft hover:border-border-hover hover:shadow-md focus-ring",
    className,
  );

  if (href) {
    return (
      <Link href={href} className={base} {...(props as Omit<React.ComponentPropsWithRef<"a">, "children">)}>
        {body}
      </Link>
    );
  }

  return (
    <div className={base} {...props}>
      {body}
    </div>
  );
}
