import * as React from "react";
import Link from "next/link";
import { ArrowRight, Gauge, Percent, RotateCcw, Trophy } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { Progress } from "@/components/ui/progress";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { formatDuration } from "@/lib/dates";
import type { DashboardData, PerformanceRow, PhotographerPerformanceRow } from "@/lib/types";
import { cn, formatPercent } from "@/lib/utils";

const seconds = (s: number | null | undefined) => (s === null || s === undefined || s < 0 ? "—" : formatDuration(s * 1000));
const pct = (ratio: number | null | undefined) => (ratio === null || ratio === undefined ? "—" : formatPercent(ratio));
const pct100 = (value: number | null | undefined) => (value === null || value === undefined ? "—" : `${Math.round(value)}%`);

/* ------------------------------------------------------------------ */
/*  Editor performance (management)                                    */
/* ------------------------------------------------------------------ */

export interface EditorPerformanceWidgetProps {
  rows: PerformanceRow[];
  max?: number;
}

/** This month's editor leaderboard: completed, average turnaround, revision rate, on-time %. */
export function EditorPerformanceWidget({ rows, max = 6 }: EditorPerformanceWidgetProps) {
  const ranked = [...rows]
    .filter((r) => r.user.isActive || r.completed > 0)
    .sort((a, b) => b.completedThisMonth - a.completedThisMonth || (b.onTimePercent ?? -1) - (a.onTimePercent ?? -1))
    .slice(0, max);
  return (
    <SectionCard
      title="Editor performance"
      description="This month"
      flush
      footer={
        <Link href="/team/performance" className="inline-flex items-center gap-1 rounded-sm font-medium text-accent-ink hover:underline focus-ring">
          Full performance
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      }
    >
      {ranked.length === 0 ? (
        <EmptyState size="sm" icon={Trophy} title="No completed work yet" description="Editor rankings appear once jobs are approved this month." />
      ) : (
        <Table density="compact">
          <THead>
            <tr>
              <TH>Editor</TH>
              <TH numeric>Done</TH>
              <TH numeric className="hidden sm:table-cell">
                Turnaround
              </TH>
              <TH numeric>Rev.</TH>
              <TH numeric>On time</TH>
            </tr>
          </THead>
          <TBody>
            {ranked.map((r) => (
              <TR key={r.user.id} interactive className="relative">
                <TD primary>
                  <Link
                    href={`/team/users/${r.user.id}`}
                    className="inline-flex min-w-0 items-center gap-2 rounded-xs text-ink focus-ring after:absolute after:inset-0 hover:underline underline-offset-2"
                  >
                    <Avatar name={r.user.name} colour={r.user.avatarColour || undefined} size="xs" />
                    <span className="truncate">{r.user.name}</span>
                  </Link>
                </TD>
                <TD numeric>{r.completedThisMonth}</TD>
                <TD numeric muted className="hidden sm:table-cell">
                  {seconds(r.avgTurnaroundSeconds)}
                </TD>
                <TD numeric className={cn(r.revisionRate !== null && r.revisionRate >= 0.4 && "text-attention-fg")}>{pct(r.revisionRate)}</TD>
                <TD numeric className={cn(r.onTimePercent !== null && r.onTimePercent < 70 && "text-danger-fg")}>{pct100(r.onTimePercent)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Rate tiles                                                         */
/* ------------------------------------------------------------------ */

function RateTile({
  title,
  icon: Icon,
  value,
  ratio,
  tone,
  sub,
  href,
}: {
  title: string;
  icon: typeof Percent;
  value: string;
  ratio: number | null;
  tone: "success" | "warning" | "danger" | "neutral";
  sub: string;
  href: string;
}) {
  return (
    <SectionCard className="h-full">
      <Link href={href} className="group/rate -m-1 flex h-full flex-col rounded-md p-1 focus-ring">
        <div className="flex items-center justify-between gap-2">
          <span className="eyebrow">{title}</span>
          <Icon aria-hidden="true" className="size-3.5 text-ink-subtle" />
        </div>
        <span className="numeric mt-2 text-3xl font-semibold leading-9 tracking-tight text-ink">{value}</span>
        <Progress value={ratio === null ? 0 : Math.round(ratio * 100)} tone={tone} size="xs" label={title} className="mt-3" />
        <p className="mt-2 text-xs text-ink-muted group-hover/rate:text-ink-secondary">{sub}</p>
      </Link>
    </SectionCard>
  );
}

/** On-time completion this month (approved jobs delivered by their editing deadline). */
export function CompletionRateWidget({ rates }: { rates: DashboardData["rates"] }) {
  const ratio = rates.onTimePercent === null ? null : rates.onTimePercent / 100;
  const tone = ratio === null ? "neutral" : ratio >= 0.85 ? "success" : ratio >= 0.7 ? "warning" : "danger";
  return (
    <RateTile
      title="On-time completion"
      icon={Percent}
      value={pct100(rates.onTimePercent)}
      ratio={ratio}
      tone={tone}
      sub={`${rates.completedThisMonth} ${rates.completedThisMonth === 1 ? "job" : "jobs"} completed this month`}
      href="/insights/analytics"
    />
  );
}

/** Revision rate this month (approved jobs that needed ≥ 1 revision). Lower is better. */
export function RevisionRateWidget({ rates }: { rates: DashboardData["rates"] }) {
  const ratio = rates.revisionRate;
  const tone = ratio === null ? "neutral" : ratio <= 0.2 ? "success" : ratio <= 0.35 ? "warning" : "danger";
  return (
    <RateTile
      title="Revision rate"
      icon={RotateCcw}
      value={pct(ratio)}
      ratio={ratio}
      tone={tone}
      sub="Approved jobs this month that needed revisions"
      href="/insights/reports?kind=editors&range=this_month"
    />
  );
}

/* ------------------------------------------------------------------ */
/*  My performance (personal)                                          */
/* ------------------------------------------------------------------ */

function Metric({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "danger" | "attention" | "success" }) {
  return (
    <div className="min-w-0 rounded-md bg-surface-sunken px-3 py-2.5">
      <dt className="eyebrow truncate">{label}</dt>
      <dd
        className={cn(
          "numeric mt-1 text-lg font-semibold leading-6 tracking-tight text-ink",
          tone === "danger" && "text-danger-fg",
          tone === "attention" && "text-attention-fg",
          tone === "success" && "text-success-fg",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

export interface MyPerformanceWidgetProps {
  editor: PerformanceRow | null;
  photographer: PhotographerPerformanceRow | null;
  /** Link to the viewer's own person page. */
  href: string | null;
}

/** Last 30 days for the viewer: editing metrics for editors, shooting/processing metrics for photographers. */
export function MyPerformanceWidget({ editor, photographer, href }: MyPerformanceWidgetProps) {
  return (
    <SectionCard
      title="My performance"
      description="Last 30 days"
      actions={
        href ? (
          <Link href={href} className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-accent-ink hover:underline focus-ring">
            Details
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        ) : null
      }
    >
      {editor ? (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Metric label="Completed" value={editor.completed} />
          <Metric label="This week" value={editor.completedThisWeek} />
          <Metric label="Turnaround" value={seconds(editor.avgTurnaroundSeconds)} />
          <Metric label="Revision rate" value={pct(editor.revisionRate)} tone={editor.revisionRate !== null && editor.revisionRate >= 0.4 ? "attention" : undefined} />
          <Metric
            label="On time"
            value={pct100(editor.onTimePercent)}
            tone={editor.onTimePercent === null ? undefined : editor.onTimePercent >= 85 ? "success" : editor.onTimePercent < 70 ? "danger" : "attention"}
          />
          <Metric label="Overdue now" value={editor.overdue} tone={editor.overdue > 0 ? "danger" : undefined} />
        </dl>
      ) : photographer ? (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Metric label="Jobs created" value={photographer.created} />
          <Metric label="Submitted" value={photographer.submitted} />
          <Metric label="Completed" value={photographer.completed} />
          <Metric label="Shoot → submit" value={seconds(photographer.avgProcessingSeconds)} />
          <Metric label="End to end" value={seconds(photographer.avgEndToEndSeconds)} />
          <Metric label="Review response" value={seconds(photographer.avgReviewResponseSeconds)} />
        </dl>
      ) : (
        <EmptyState size="sm" icon={Gauge} title="Nothing to measure yet" description="Your numbers appear once you have completed work in the last 30 days." />
      )}
    </SectionCard>
  );
}
