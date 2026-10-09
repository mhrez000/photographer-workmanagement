import * as React from "react";
import { Check, Minus, X } from "lucide-react";
import { DueChip, ExternalLinkButton, JobLink, PausedChip, PersonChip, PriorityPill, RevisionCount, StatusPill } from "@/components/jobs";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { LINK_KIND_META, STATUS_CATEGORY_META } from "@/lib/constants";
import { formatDate } from "@/lib/dates";
import type { CompletedWorkItem, JobRow } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface JobMiniListProps {
  jobs: JobRow[];
  timeZone: string;
  /** Which person column to show (the other side of the relationship). */
  person?: "editor" | "photographer" | "none";
  /** Rendered when `jobs` is empty. */
  empty?: React.ReactNode;
  className?: string;
}

/**
 * Compact job list for person pages: table from md up, stacked cards below
 * (thumb-friendly). Status pills use the workflow colour; overdue rows get a
 * danger rail so they read before anything else.
 */
export function JobMiniList({ jobs, timeZone, person = "editor", empty, className }: JobMiniListProps) {
  if (jobs.length === 0) return <>{empty ?? null}</>;
  return (
    <div className={className}>
      <div className="hidden md:block">
        <Table>
          <THead>
            <tr>
              <TH>Job</TH>
              <TH>Status</TH>
              {person !== "none" ? <TH>{person === "editor" ? "Editor" : "Photographer"}</TH> : null}
              <TH>Priority</TH>
              <TH>Due</TH>
              <TH numeric shrink>
                Rev.
              </TH>
            </tr>
          </THead>
          <TBody>
            {jobs.map((j) => (
              <TR key={j.id} className={cn(j.isOverdue && "shadow-[inset_2px_0_0_var(--danger)]")}>
                <TD className="max-w-80">
                  <div className="flex min-w-0 flex-col">
                    <JobLink job={j} />
                    <span className="truncate text-xs text-ink-muted">{j.client.name}</span>
                  </div>
                </TD>
                <TD>
                  <span className="inline-flex items-center gap-1.5">
                    <StatusPill status={j.status} size="sm" />
                    {j.isPaused ? <PausedChip compact /> : null}
                  </span>
                </TD>
                {person !== "none" ? (
                  <TD>
                    <PersonChip user={person === "editor" ? j.editor : j.photographer} size="xs" />
                  </TD>
                ) : null}
                <TD>
                  <PriorityPill priority={j.priority} size="sm" quietNormal />
                </TD>
                <TD>
                  <DueChip due={j.dueDate} timeZone={timeZone} done={STATUS_CATEGORY_META[j.statusCategory].done} compact />
                </TD>
                <TD numeric>
                  <RevisionCount count={j.revisionCount} />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
      <ul className="flex flex-col divide-y divide-border md:hidden">
        {jobs.map((j) => (
          <li key={j.id} className={cn("flex flex-col gap-1.5 px-4 py-3", j.isOverdue && "shadow-[inset_2px_0_0_var(--danger)]")}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <JobLink job={j} wrap />
                <p className="truncate text-xs text-ink-muted">{j.client.name}</p>
              </div>
              <DueChip due={j.dueDate} timeZone={timeZone} done={STATUS_CATEGORY_META[j.statusCategory].done} compact />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusPill status={j.status} size="xs" />
              <PriorityPill priority={j.priority} size="sm" quietNormal />
              <RevisionCount count={j.revisionCount} />
              {person !== "none" ? <PersonChip user={person === "editor" ? j.editor : j.photographer} size="xs" className="ml-auto" /> : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OnTimeMark({ value }: { value: boolean | null }) {
  if (value === true)
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-success-fg" title="Approved on or before the due date">
        <Check aria-hidden="true" className="size-3.5 text-success" />
        On time
      </span>
    );
  if (value === false)
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-danger-fg" title="Approved after the due date">
        <X aria-hidden="true" className="size-3.5 text-danger" />
        Late
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-xs text-ink-subtle" title="No due date was set">
      <Minus aria-hidden="true" className="size-3.5" />
      No due date
    </span>
  );
}

function FinishedLink({ job }: { job: JobRow }) {
  const link = job.primaryLink;
  if (!link || !LINK_KIND_META[link.kind].finishedWork) return <span className="text-xs text-ink-subtle">No finished link</span>;
  return <ExternalLinkButton url={link.url} label={link.label ?? LINK_KIND_META[link.kind].label} size="sm" />;
}

/** Finished jobs with completion date, on-time ✓/✗ and the finished-work link. */
export function CompletedWorkList({
  items,
  timeZone,
  person = "editor",
  empty,
}: {
  items: CompletedWorkItem[];
  timeZone: string;
  person?: "editor" | "photographer" | "none";
  empty?: React.ReactNode;
}) {
  if (items.length === 0) return <>{empty ?? null}</>;
  return (
    <div>
      <div className="hidden md:block">
        <Table>
          <THead>
            <tr>
              <TH>Job</TH>
              {person !== "none" ? <TH>{person === "editor" ? "Editor" : "Photographer"}</TH> : null}
              <TH>Finished</TH>
              <TH>On time</TH>
              <TH numeric shrink>
                Rev.
              </TH>
              <TH>Finished work</TH>
            </tr>
          </THead>
          <TBody>
            {items.map(({ job, completedAt, approvedAt, wasOnTime }) => (
              <TR key={job.id}>
                <TD className="max-w-80">
                  <div className="flex min-w-0 flex-col">
                    <JobLink job={job} />
                    <span className="truncate text-xs text-ink-muted">{job.client.name}</span>
                  </div>
                </TD>
                {person !== "none" ? (
                  <TD>
                    <PersonChip user={person === "editor" ? job.editor : job.photographer} size="xs" />
                  </TD>
                ) : null}
                <TD muted>
                  <span className="numeric">{formatDate(completedAt ?? approvedAt, timeZone)}</span>
                  {completedAt ? null : <span className="ml-1.5 text-2xs text-ink-subtle">(approved)</span>}
                </TD>
                <TD>
                  <OnTimeMark value={wasOnTime} />
                </TD>
                <TD numeric>
                  <RevisionCount count={job.revisionCount} showZero />
                </TD>
                <TD>
                  <FinishedLink job={job} />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
      <ul className="flex flex-col divide-y divide-border md:hidden">
        {items.map(({ job, completedAt, approvedAt, wasOnTime }) => (
          <li key={job.id} className="flex flex-col gap-1.5 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <JobLink job={job} wrap />
                <p className="truncate text-xs text-ink-muted">
                  {job.client.name} · <span className="numeric">{formatDate(completedAt ?? approvedAt, timeZone)}</span>
                </p>
              </div>
              <OnTimeMark value={wasOnTime} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <RevisionCount count={job.revisionCount} showZero />
              <FinishedLink job={job} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
