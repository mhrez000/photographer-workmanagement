import * as React from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { AlarmClock, CalendarClock, CircleCheckBig, Eye, Layers, PenTool, RotateCcw, UserRoundCheck } from "lucide-react";
import { CATEGORY_GROUPS } from "@/lib/constants";
import type { DashboardData, KpiSummary } from "@/lib/types";
import { cn, formatNumber, pluralise } from "@/lib/utils";

type Tone = "default" | "attention" | "danger" | "success" | "accent";

interface KpiDef {
  key: keyof Omit<KpiSummary, "asOf">;
  label: string;
  icon: LucideIcon;
  href: string;
  /** Tone when the value is non-zero (zero is always calm). */
  tone: Tone;
  sub?: (k: KpiSummary, rates: DashboardData["rates"]) => string | null;
}

const ALL_WORK = "/workspace/all";

/** The eight KPI cards (spec §3) and the All Work view each one drills into. */
export const KPI_DEFS: readonly KpiDef[] = [
  {
    key: "active",
    label: "Active jobs",
    icon: Layers,
    href: `${ALL_WORK}?statusCategory=${CATEGORY_GROUPS.ACTIVE.join(",")}`,
    tone: "accent",
    sub: (k) => [k.unassigned ? `${formatNumber(k.unassigned)} unassigned` : null, k.paused ? `${formatNumber(k.paused)} paused` : null].filter(Boolean).join(" · ") || null,
  },
  { key: "dueToday", label: "Due today", icon: CalendarClock, href: `${ALL_WORK}?quick=due_today`, tone: "attention" },
  { key: "overdue", label: "Overdue", icon: AlarmClock, href: `${ALL_WORK}?quick=overdue`, tone: "danger", sub: (k) => (k.overdue ? "Past the editing deadline" : null) },
  {
    key: "awaitingEditor",
    label: "Awaiting editor",
    icon: UserRoundCheck,
    href: `${ALL_WORK}?statusCategory=${CATEGORY_GROUPS.AWAITING_EDITOR.join(",")}`,
    tone: "default",
    sub: () => "Assigned, not started",
  },
  { key: "inEditing", label: "In editing", icon: PenTool, href: `${ALL_WORK}?statusCategory=${CATEGORY_GROUPS.IN_EDITING.join(",")}`, tone: "default" },
  {
    key: "awaitingReview",
    label: "Awaiting review",
    icon: Eye,
    href: `${ALL_WORK}?quick=awaiting_review`,
    tone: "default",
    sub: (k) => (k.reviewOverdue ? `${formatNumber(k.reviewOverdue)} past review deadline` : null),
  },
  { key: "revisionRequired", label: "Revision required", icon: RotateCcw, href: `${ALL_WORK}?quick=revision_required`, tone: "attention" },
  {
    key: "completedThisWeek",
    label: "Completed this week",
    icon: CircleCheckBig,
    href: `${ALL_WORK}?quick=completed`,
    tone: "success",
    sub: (_k, rates) => `${formatNumber(rates.completedThisMonth)} this month`,
  },
];

const valueTone: Record<Tone, string> = {
  default: "text-ink",
  accent: "text-ink",
  attention: "text-attention-fg",
  danger: "text-danger-fg",
  success: "text-success-fg",
};

const iconTone: Record<Tone, string> = {
  default: "bg-surface-muted text-ink-muted",
  accent: "bg-accent-soft text-accent-ink",
  attention: "bg-attention-soft text-attention",
  danger: "bg-danger-soft text-danger",
  success: "bg-success-soft text-success",
};

export interface KpiStripProps {
  kpis: KpiSummary;
  rates: DashboardData["rates"];
  className?: string;
}

/** Eight compact KPI cards; each links to the matching filtered All Work view. */
export function KpiStrip({ kpis, rates, className }: KpiStripProps) {
  return (
    <section aria-label="Key numbers" className={cn("@container", className)}>
      <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4 @4xl:gap-4">
      {KPI_DEFS.map((def) => {
        const value = kpis[def.key];
        const tone: Tone = value > 0 ? def.tone : "default";
        const Icon = def.icon;
        const sub = def.sub?.(kpis, rates) ?? null;
        return (
          <Link
            key={def.key}
            href={def.href}
            aria-label={`${def.label}: ${pluralise(value, "job")}. View in All Work`}
            className={cn(
              "group/kpi relative flex min-w-0 flex-col rounded-lg border border-border bg-surface px-4 py-3 shadow-xs",
              "transition-[box-shadow,border-color,transform] duration-(--motion-base) ease-out-soft",
              "hover:-translate-y-px hover:border-border-hover hover:shadow-md focus-ring",
              tone === "danger" && "border-danger/25",
              tone === "attention" && "border-attention/25",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="eyebrow min-w-0 truncate">{def.label}</span>
              <span className={cn("hidden size-6 shrink-0 items-center justify-center rounded-sm @lg:flex", iconTone[tone])}>
                <Icon aria-hidden="true" className="size-3.5" />
              </span>
            </div>
            <span className={cn("numeric mt-1 text-2xl font-semibold leading-8 tracking-tight", valueTone[tone])}>
              {formatNumber(value)}
            </span>
            <span className="mt-0.5 truncate text-xs text-ink-muted">{sub ?? " "}</span>
          </Link>
        );
      })}
      </div>
    </section>
  );
}
