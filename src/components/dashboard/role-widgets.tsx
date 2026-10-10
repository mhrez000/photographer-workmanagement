import * as React from "react";
import Link from "next/link";
import { ArrowRight, CalendarClock, MessageCircleQuestion, Store, Timer, TrendingDown, TrendingUp } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { DueChip } from "@/components/jobs/due-chip";
import { JobLink } from "@/components/jobs/job-link";
import { PersonChip } from "@/components/jobs/person";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDateShort, formatDateTime, formatDuration, formatRelative } from "@/lib/dates";
import type { DashboardDeadline, DashboardQuestion, DashboardScopedList, TurnaroundSummary } from "@/lib/types";
import { cn, pluralise } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  "N more in Whole business →" (docs/ROLES.md §8)                    */
/* ------------------------------------------------------------------ */

export function MoreInBusinessLink({ count, href = "/dashboard?scope=business", noun = "waiting" }: { count: number; href?: string; noun?: string }) {
  if (count <= 0) return null;
  return (
    <Link href={href} data-more-in-business="" className="inline-flex items-center gap-1 rounded-sm text-ink-muted hover:text-ink hover:underline focus-ring">
      {count} more {noun} in Whole business
      <ArrowRight aria-hidden="true" className="size-3.5" />
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/*  Questions: open editor questions + waiting client feedback         */
/* ------------------------------------------------------------------ */

export interface QuestionsWidgetProps {
  list: DashboardScopedList<DashboardQuestion>;
  /** In "mine" scope: link to the rest of the business. */
  showMore: boolean;
}

/** `questions` widget (docs/ROLES.md §6.4, §7.5). */
export function QuestionsWidget({ list, showMore }: QuestionsWidgetProps) {
  const { items, total, moreInBusiness } = list;
  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          Questions & client feedback
          <span className={cn("numeric rounded-full px-1.5 text-2xs font-medium", total > 0 ? "bg-attention-soft text-attention-fg" : "bg-surface-muted text-ink-muted")}>
            {total}
          </span>
        </span>
      }
      description="Editors waiting for an answer, and client threads waiting for the studio."
      flush
      footer={showMore && moreInBusiness > 0 ? <MoreInBusinessLink count={moreInBusiness} /> : undefined}
    >
      {items.length === 0 ? (
        <EmptyState size="sm" icon={MessageCircleQuestion} title="Nothing waiting on you" description="Open editor questions and new client feedback show up here." />
      ) : (
        <ul className="divide-y divide-border">
          {items.slice(0, 6).map((q) => (
            <li key={q.commentId} className="relative flex items-start gap-3 px-5 py-2.5 transition-colors duration-(--motion-fast) hover:bg-surface-muted/50">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <JobLink job={q.job} tab="comments" className="min-w-0 text-sm after:absolute after:inset-0" />
                  {q.kind === "client_feedback" ? (
                    <Badge variant="outline" size="sm">
                      <Store aria-hidden="true" /> Client
                    </Badge>
                  ) : (
                    <Badge variant="info" size="sm">
                      Question
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 line-clamp-2 text-xs text-ink-secondary">{q.excerpt}</p>
                <div className="mt-1 flex items-center gap-2 text-xs text-ink-muted">
                  <PersonChip user={q.author} size="xs" className="max-w-[10rem] [&_span.truncate]:text-xs" />
                </div>
              </div>
              <time dateTime={q.waitingSince} className="shrink-0 pt-0.5 text-xs text-ink-muted numeric">
                {formatRelative(q.waitingSince)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Upcoming deadlines (next 7 days)                                   */
/* ------------------------------------------------------------------ */

const DEADLINE_LABEL: Record<DashboardDeadline["kind"], string> = {
  due: "Editing due",
  review_due: "Review due",
  delivery_due: "Delivery",
};

export function UpcomingDeadlinesWidget({ items, timeZone }: { items: DashboardDeadline[]; timeZone: string }) {
  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          Upcoming deadlines
          <span className="numeric rounded-full bg-surface-muted px-1.5 text-2xs font-medium text-ink-secondary">{items.length}</span>
        </span>
      }
      description="Editing, review and delivery dates in the next 7 days."
      flush
      footer={
        items.length > 0 ? (
          <Link href="/workspace/calendar" className="inline-flex items-center gap-1 rounded-sm font-medium text-accent-ink hover:underline focus-ring">
            Open the calendar
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        ) : undefined
      }
    >
      {items.length === 0 ? (
        <EmptyState size="sm" icon={CalendarClock} title="A clear week" description="No editing, review or delivery dates in the next 7 days." />
      ) : (
        <ul className="divide-y divide-border">
          {items.slice(0, 8).map((d) => (
            <li key={`${d.job.id}:${d.kind}`} className="relative flex items-center gap-3 px-5 py-2.5 transition-colors duration-(--motion-fast) hover:bg-surface-muted/50">
              <div className="min-w-0 flex-1">
                <JobLink job={d.job} className="min-w-0 text-sm after:absolute after:inset-0" />
                <p className="mt-0.5 truncate text-xs text-ink-muted">
                  {DEADLINE_LABEL[d.kind]} · {d.job.client.name}
                </p>
              </div>
              {d.kind === "due" ? (
                <DueChip due={d.at} timeZone={timeZone} compact />
              ) : (
                <time dateTime={d.at} title={formatDateTime(d.at, timeZone)} className="shrink-0 text-xs text-ink-muted numeric">
                  {formatDateShort(d.at, timeZone)}
                </time>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Turnaround (analytics)                                             */
/* ------------------------------------------------------------------ */

function TurnaroundStat({ label, value }: { label: string; value: TurnaroundSummary["shootToDelivered"] }) {
  const current = value.current;
  const previous = value.previous;
  const faster = current !== null && previous !== null ? current < previous : null;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border p-3">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="flex items-baseline gap-2">
        <span className="numeric text-lg font-semibold text-ink">{current === null ? "—" : formatDuration(current * 1000)}</span>
        {faster !== null && previous !== null ? (
          <span className={cn("inline-flex items-center gap-0.5 text-xs", faster ? "text-success-fg" : "text-danger-fg")}>
            {faster ? <TrendingDown aria-hidden="true" className="size-3.5" /> : <TrendingUp aria-hidden="true" className="size-3.5" />}
            {faster ? "faster" : "slower"} than {formatDuration(previous * 1000, { compact: true })}
          </span>
        ) : null}
      </dd>
      <p className="text-2xs text-ink-subtle">Median of {pluralise(value.count, "job")}, last 30 days vs the 30 before</p>
    </div>
  );
}

export function TurnaroundWidget({ summary }: { summary: TurnaroundSummary }) {
  const empty = summary.shootToDelivered.count === 0 && summary.submittedToReviewed.count === 0;
  return (
    <SectionCard
      title="Turnaround"
      description="How long production takes, business-wide."
      actions={<Timer aria-hidden="true" className="size-4 text-ink-subtle" />}
      footer={
        <Link href="/insights/analytics" className="inline-flex items-center gap-1 rounded-sm font-medium text-accent-ink hover:underline focus-ring">
          Analytics
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      }
    >
      {empty ? (
        <EmptyState size="sm" icon={Timer} title="Not enough history yet" description="Turnaround appears once jobs are delivered and reviewed." />
      ) : (
        <dl className="grid gap-3 sm:grid-cols-2">
          <TurnaroundStat label="Shoot → delivered" value={summary.shootToDelivered} />
          <TurnaroundStat label="Submitted → reviewed" value={summary.submittedToReviewed} />
        </dl>
      )}
    </SectionCard>
  );
}
