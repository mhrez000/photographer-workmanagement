import * as React from "react";
import Link from "next/link";
import { ChevronRight, MapPin } from "lucide-react";
import { SimpleDueChip } from "@/components/jobs-list/simple-due-chip";
import { jobHref } from "@/components/jobs/job-link";
import { RoundBadge, RushBadge, StagePill } from "@/components/jobs/stage-pill";
import type { SimpleJobRow } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface AddressGroup {
  key: string;
  address: string;
  jobs: SimpleJobRow[];
  active: number;
  late: number;
}

/**
 * Groups a client's jobs by property (the project's address, else its name). Addresses with active work
 * come first (soonest due), finished-only addresses after, newest first. Row order inside a group is the
 * query's: due soonest first.
 */
export function groupJobsByAddress(jobs: readonly SimpleJobRow[]): AddressGroup[] {
  const map = new Map<string, AddressGroup>();
  for (const job of jobs) {
    const address = (job.project.address ?? job.project.name).trim() || job.project.name;
    const g = map.get(job.project.id) ?? { key: job.project.id, address, jobs: [], active: 0, late: 0 };
    g.jobs.push(job);
    if (job.stage.active) g.active += 1;
    if (job.due.late) g.late += 1;
    map.set(job.project.id, g);
  }
  const groups = [...map.values()];
  const firstDue = (g: AddressGroup) => g.jobs.find((j) => j.stage.active && j.due.civilDate)?.due.civilDate ?? "9999-99-99";
  const latest = (g: AddressGroup) => g.jobs.reduce((m, j) => (j.updatedAt > m ? j.updatedAt : m), "");
  return groups.sort((a, b) => {
    if ((a.active > 0) !== (b.active > 0)) return a.active > 0 ? -1 : 1;
    if (a.active > 0) return firstDue(a).localeCompare(firstDue(b)) || a.address.localeCompare(b.address);
    return latest(b).localeCompare(latest(a)) || a.address.localeCompare(b.address);
  });
}

export interface ClientJobsByAddressProps {
  jobs: readonly SimpleJobRow[];
  timeZone: string;
  className?: string;
}

/** The client page's job list (plan §3 "Clients"): jobs grouped by address, each row with its stage pill. */
export function ClientJobsByAddress({ jobs, timeZone, className }: ClientJobsByAddressProps) {
  const groups = groupJobsByAddress(jobs);
  return (
    <div className={cn("flex flex-col divide-y divide-border", className)}>
      {groups.map((group) => (
        <section key={group.key} aria-label={group.address} className="py-1">
          <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-1 pt-3 sm:px-5">
            <h3 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-ink">
              <MapPin aria-hidden="true" className="size-3.5 shrink-0 text-ink-subtle" />
              <span className="truncate">{group.address}</span>
            </h3>
            <span className="text-xs text-ink-muted numeric">
              {group.jobs.length} {group.jobs.length === 1 ? "job" : "jobs"}
              {group.active > 0 ? ` · ${group.active} active` : ""}
              {group.late > 0 ? <span className="font-medium text-danger-fg"> · {group.late} late</span> : null}
            </span>
          </header>
          <ul className="flex flex-col">
            {group.jobs.map((job) => (
              <li key={job.id}>
                <Link
                  href={jobHref(job.id)}
                  className={cn(
                    "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5 transition-colors duration-(--motion-fast) hover:bg-surface-muted focus-visible:bg-surface-muted focus-ring sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:px-5",
                    !job.stage.active && "opacity-75",
                  )}
                >
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="truncate text-sm font-medium text-ink">{job.name !== group.address ? job.name : job.jobTypeName}</span>
                      {job.name !== group.address ? <span className="text-xs text-ink-muted">{job.jobTypeName}</span> : null}
                      <RushBadge rush={job.rush} />
                      <RoundBadge round={job.round} />
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-muted">
                      <span className="numeric">{job.jobNumber}</span>
                      {job.waitingOn ? (
                        <span>
                          Waiting on <span className={job.waitingOn === "You" ? "font-medium text-attention-fg" : "text-ink-secondary"}>{job.waitingOn}</span>
                        </span>
                      ) : job.editor ? (
                        <span>Edited by {job.editor.name}</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="col-start-1 row-start-2 flex flex-wrap items-center gap-2 sm:col-start-auto sm:row-start-auto">
                    <StagePill display={job.stage} job={{ category: job.statusCategory, revisionCount: 0, startedAt: job.startedAt }} timeZone={timeZone} />
                  </div>
                  <div className="hidden sm:block">
                    <SimpleDueChip due={job.due} active={job.stage.active} />
                  </div>
                  <ChevronRight aria-hidden="true" className="col-start-2 row-start-1 size-4 shrink-0 text-ink-subtle sm:col-start-auto sm:row-start-auto" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
