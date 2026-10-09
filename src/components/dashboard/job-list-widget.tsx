import * as React from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ArrowRight, Pause } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { DueChip } from "@/components/jobs/due-chip";
import { JobLink } from "@/components/jobs/job-link";
import { ExternalLinkButton } from "@/components/jobs/link-provider";
import { PersonChip } from "@/components/jobs/person";
import { PriorityPill } from "@/components/jobs/priority-pill";
import { RevisionCount } from "@/components/jobs/revision-count";
import { StatusPill } from "@/components/jobs/status-pill";
import { EmptyState } from "@/components/ui/empty-state";
import { LINK_KIND_META } from "@/lib/constants";
import { formatDateShort, formatDateTime } from "@/lib/dates";
import type { JobRow } from "@/lib/types";
import { cn } from "@/lib/utils";

export type JobListVariant = "due" | "completed" | "queue";

export interface DashboardJobRowsProps {
  jobs: JobRow[];
  timeZone: string;
  variant?: JobListVariant;
  /** Who to show on the secondary line. */
  person?: "editor" | "photographer";
  max?: number;
}

/** Compact job rows for dashboard widgets: number + name, client · person · status, and a right-hand chip. */
export function DashboardJobRows({ jobs, timeZone, variant = "due", person = "editor", max = 6 }: DashboardJobRowsProps) {
  return (
    <ul className="divide-y divide-border">
      {jobs.slice(0, max).map((job) => {
        const who = person === "editor" ? job.editor : job.photographer;
        const finished = job.primaryLink && LINK_KIND_META[job.primaryLink.kind]?.finishedWork ? job.primaryLink : null;
        return (
          <li key={job.id} className="relative flex items-start gap-3 px-5 py-2.5 transition-colors duration-(--motion-fast) hover:bg-surface-muted/50">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <JobLink job={job} className="min-w-0 text-sm after:absolute after:inset-0" />
                {job.isPaused ? (
                  <Pause aria-label="Paused" className="size-3 shrink-0 text-ink-subtle" />
                ) : null}
                <RevisionCount count={job.revisionCount} />
              </div>
              <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
                <span className="max-w-[14rem] truncate">{job.client.name}</span>
                <span aria-hidden="true" className="text-ink-subtle">
                  ·
                </span>
                <PersonChip user={who} size="xs" emptyLabel={person === "editor" ? "No editor" : "No photographer"} className="max-w-[10rem] [&_span.truncate]:text-xs" />
                <StatusPill status={{ ...job.status, category: job.statusCategory }} size="xs" />
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
              {variant === "completed" ? (
                <>
                  <span className="numeric text-xs text-ink-muted" title={`Completed ${formatDateTime(job.statusEnteredAt, timeZone)}`}>
                    {formatDateShort(job.statusEnteredAt, timeZone)}
                  </span>
                  {finished ? (
                    <ExternalLinkButton url={finished.url} label={finished.label ?? LINK_KIND_META[finished.kind].label} size="sm" variant="ghost" hideHost className="relative z-[1]" />
                  ) : null}
                </>
              ) : (
                <>
                  <DueChip due={job.dueDate} timeZone={timeZone} compact />
                  <PriorityPill priority={job.priority} compact quietNormal />
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export interface JobListWidgetProps {
  title: string;
  description?: string;
  jobs: JobRow[];
  /** Total behind the list (e.g. the KPI value) — drives "View all N". */
  total?: number;
  timeZone: string;
  variant?: JobListVariant;
  person?: "editor" | "photographer";
  viewAllHref: string;
  viewAllLabel?: string;
  empty: { icon: LucideIcon; title: string; description: string };
  tone?: "default" | "danger" | "attention";
  max?: number;
  /** Hide the count bubble (lists that are a window, not a total). */
  showCount?: boolean;
}

/** A titled job list card with a count, an empty state and a "View all" footer. */
export function JobListWidget({
  title,
  description,
  jobs,
  total,
  timeZone,
  variant = "due",
  person,
  viewAllHref,
  viewAllLabel,
  empty,
  tone = "default",
  max = 6,
  showCount = true,
}: JobListWidgetProps) {
  const count = total ?? jobs.length;
  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          {title}
          {showCount ? (
          <span
            className={cn(
              "numeric rounded-full px-1.5 text-2xs font-medium",
              count === 0
                ? "bg-surface-muted text-ink-muted"
                : tone === "danger"
                  ? "bg-danger-soft text-danger-fg"
                  : tone === "attention"
                    ? "bg-attention-soft text-attention-fg"
                    : "bg-surface-muted text-ink-secondary",
            )}
          >
            {count}
          </span>
          ) : null}
        </span>
      }
      description={description}
      flush
      footer={
        jobs.length > 0 ? (
          <Link href={viewAllHref} className="inline-flex items-center gap-1 rounded-sm font-medium text-accent-ink hover:underline focus-ring">
            {viewAllLabel ?? (count > Math.min(max, jobs.length) ? `View all ${count}` : "Open in All Work")}
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        ) : undefined
      }
    >
      {jobs.length === 0 ? (
        <EmptyState size="sm" icon={empty.icon} title={empty.title} description={empty.description} />
      ) : (
        <DashboardJobRows jobs={jobs} timeZone={timeZone} variant={variant} person={person} max={max} />
      )}
    </SectionCard>
  );
}
