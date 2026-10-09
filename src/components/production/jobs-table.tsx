import * as React from "react";
import Link from "next/link";
import { DueChip, JobLink, PausedChip, PersonChip, PriorityPill, RevisionCount, StatusPill } from "@/components/jobs";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { STATUS_CATEGORY_META } from "@/lib/constants";
import type { JobRow } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface ProductionJobsTableProps {
  jobs: JobRow[];
  timeZone: string;
  /** Show the client column (client-less contexts like a project page hide it). */
  showClient?: boolean;
  /** Show the project column. */
  showProject?: boolean;
  /** Show the job type column. */
  showType?: boolean;
  className?: string;
}

function isFinished(job: JobRow): boolean {
  return STATUS_CATEGORY_META[job.statusCategory].done || job.statusCategory === "cancelled";
}

/**
 * Jobs of a client / project. A dense table from `md`, a stack of tappable
 * cards below it (photographers on phones, spec §28).
 */
export function ProductionJobsTable({ jobs, timeZone, showClient = false, showProject = true, showType = true, className }: ProductionJobsTableProps) {
  return (
    <div className={className}>
      <div className="hidden md:block">
        <Table>
          <THead>
            <tr>
              <TH>Job</TH>
              {showClient ? <TH>Client</TH> : null}
              {showProject ? <TH>Project</TH> : null}
              {showType ? <TH>Type</TH> : null}
              <TH>Status</TH>
              <TH>Editor</TH>
              <TH>Photographer</TH>
              <TH>Due</TH>
              <TH shrink>Priority</TH>
            </tr>
          </THead>
          <TBody>
            {jobs.map((job) => (
              <TR key={job.id} className={cn(job.statusCategory === "cancelled" && "opacity-60")}>
                <TD className="max-w-[18rem]">
                  <div className="flex min-w-0 items-center gap-2">
                    <JobLink job={job} />
                    {job.revisionCount > 0 ? <RevisionCount count={job.revisionCount} /> : null}
                    {job.isPaused ? <PausedChip compact /> : null}
                  </div>
                </TD>
                {showClient ? (
                  <TD truncate muted className="max-w-[10rem]">
                    <Link href={`/clients/${job.client.id}`} className="rounded-xs hover:text-ink hover:underline focus-ring">
                      {job.client.name}
                    </Link>
                  </TD>
                ) : null}
                {showProject ? (
                  <TD truncate muted className="max-w-[12rem]">
                    <Link href={`/projects/${job.project.id}`} className="rounded-xs hover:text-ink hover:underline focus-ring">
                      {job.project.name}
                    </Link>
                  </TD>
                ) : null}
                {showType ? (
                  <TD muted>
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                      <span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: job.jobType.colour }} />
                      {job.jobType.name}
                    </span>
                  </TD>
                ) : null}
                <TD>
                  <StatusPill status={job.status} size="sm" />
                </TD>
                <TD>
                  <PersonChip user={job.editor} size="xs" emptyLabel="Unassigned" />
                </TD>
                <TD>
                  <PersonChip user={job.photographer} size="xs" emptyLabel="—" />
                </TD>
                <TD>
                  <DueChip due={job.dueDate} timeZone={timeZone} done={isFinished(job)} compact />
                </TD>
                <TD>
                  <PriorityPill priority={job.priority} compact quietNormal />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>

      <ul className="flex flex-col divide-y divide-border md:hidden">
        {jobs.map((job) => (
          <li key={job.id} className={cn("relative flex flex-col gap-2 px-4 py-3", job.statusCategory === "cancelled" && "opacity-60")}>
            <div className="flex items-start justify-between gap-3">
              <JobLink job={job} wrap className="text-sm" />
              <PriorityPill priority={job.priority} compact quietNormal />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
              <StatusPill status={job.status} size="xs" />
              <DueChip due={job.dueDate} timeZone={timeZone} done={isFinished(job)} compact />
              {job.revisionCount > 0 ? <RevisionCount count={job.revisionCount} /> : null}
              {job.isPaused ? <PausedChip compact /> : null}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
              <PersonChip user={job.editor} size="xs" emptyLabel="No editor" />
              {showType ? <span>{job.jobType.name}</span> : null}
              {showProject ? <span className="truncate">{job.project.name}</span> : null}
              {showClient ? <span className="truncate">{job.client.name}</span> : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
