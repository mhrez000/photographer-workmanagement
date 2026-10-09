import * as React from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export type StatTone = "default" | "accent" | "attention" | "danger" | "success" | "info" | "muted";

const toneValue: Record<StatTone, string> = {
  default: "text-ink",
  accent: "text-accent-ink",
  attention: "text-attention-fg",
  danger: "text-danger-fg",
  success: "text-success-fg",
  info: "text-info-fg",
  muted: "text-ink-muted",
};

const toneIcon: Record<StatTone, string> = {
  default: "text-ink-subtle",
  accent: "text-accent",
  attention: "text-attention",
  danger: "text-danger",
  success: "text-success",
  info: "text-info",
  muted: "text-ink-subtle",
};

export interface StatTileProps {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Secondary line ("of 12 active", "avg 2d 4h"). */
  sub?: React.ReactNode;
  tone?: StatTone;
  icon?: LucideIcon;
  /** Make the tile a link (drill-down). */
  href?: string;
  className?: string;
}

/**
 * Compact metric tile for detail pages and side panels (lighter than the
 * dashboard KpiCard): eyebrow label, large tabular value, sub-line.
 */
export function StatTile({ label, value, sub, tone = "default", icon: Icon, href, className }: StatTileProps) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="eyebrow truncate">{label}</span>
        {Icon ? <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", toneIcon[tone])} /> : null}
        {href && !Icon ? (
          <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-ink-subtle transition-transform group-hover/stat:translate-x-0.5" />
        ) : null}
      </div>
      <div className={cn("mt-1.5 text-xl font-semibold leading-7 tracking-tight numeric", toneValue[tone])}>{value}</div>
      {sub ? <div className="mt-0.5 truncate text-xs text-ink-muted">{sub}</div> : null}
    </>
  );
  const classes = cn(
    "group/stat flex min-w-0 flex-col rounded-md border border-border bg-surface px-3.5 py-3",
    href && "transition-[border-color,box-shadow] duration-(--motion-fast) hover:border-border-hover hover:shadow-xs focus-ring",
    className,
  );
  if (href) {
    return (
      <Link href={href} className={classes}>
        {body}
      </Link>
    );
  }
  return <div className={classes}>{body}</div>;
}
