import * as React from "react";
import Link from "next/link";
import type { JobRef } from "@/lib/types";
import { cn } from "@/lib/utils";

export type JobDetailTab =
  | "overview"
  | "links"
  | "notes"
  | "comments"
  | "revisions"
  | "timeline"
  | "activity"
  | "history"
  | "time";

/** `/jobs/[id]` (optionally on a tab). */
export function jobHref(jobId: string, tab?: JobDetailTab): string {
  return tab && tab !== "overview" ? `/jobs/${jobId}?tab=${tab}` : `/jobs/${jobId}`;
}

export interface JobLinkProps {
  job: Pick<JobRef, "id" | "jobNumber" | "name">;
  /** Show the PJ-0042 number before the name. Default true. */
  showNumber?: boolean;
  /** Only the number (e.g. inside activity sentences). */
  numberOnly?: boolean;
  tab?: JobDetailTab;
  className?: string;
  /** Wrap long names instead of truncating. */
  wrap?: boolean;
}

/** Link to a job: muted tabular number + name, truncating gracefully. */
export function JobLink({ job, showNumber = true, numberOnly = false, tab, className, wrap = false }: JobLinkProps) {
  return (
    <Link
      href={jobHref(job.id, tab)}
      title={`${job.jobNumber} · ${job.name}`}
      className={cn(
        "group/job inline-flex min-w-0 max-w-full items-baseline gap-1.5 rounded-xs text-ink focus-ring",
        className,
      )}
    >
      {showNumber || numberOnly ? (
        <span className="shrink-0 font-mono text-xs text-ink-muted numeric group-hover/job:text-ink-secondary">{job.jobNumber}</span>
      ) : null}
      {numberOnly ? null : (
        <span className={cn("font-medium underline-offset-2 group-hover/job:underline", wrap ? "break-words" : "truncate")}>
          {job.name}
        </span>
      )}
    </Link>
  );
}
