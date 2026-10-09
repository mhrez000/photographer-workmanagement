/**
 * Mobile job card (< md): progressive disclosure — one scannable summary line
 * ("123 Smith Street · John · Editing · Due today"), the rest on tap.
 * Server-safe.
 */
import * as React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { DueChip } from "@/components/jobs/due-chip";
import { jobHref } from "@/components/jobs/job-link";
import { PausedChip } from "@/components/jobs/paused-chip";
import { PriorityPill } from "@/components/jobs/priority-pill";
import { RevisionCount } from "@/components/jobs/revision-count";
import { StatusPill } from "@/components/jobs/status-pill";
import type { JobRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { deadlineSettled } from "./cells";

function firstName(name: string | undefined | null): string | null {
  if (!name) return null;
  return name.trim().split(/\s+/)[0] ?? null;
}

export interface JobCardProps {
  row: JobRow;
  timeZone: string;
  /** Hide the person the list is already grouped by. */
  hidePerson?: "editor" | "photographer";
  selected?: boolean;
  className?: string;
}

export function JobCard({ row, timeZone, hidePerson, selected = false, className }: JobCardProps) {
  const people = [
    hidePerson !== "photographer" ? firstName(row.photographer?.name) : null,
    hidePerson !== "editor" ? (row.editor ? firstName(row.editor.name) : "Unassigned") : null,
  ].filter(Boolean);

  return (
    <Link
      href={jobHref(row.id)}
      data-state={selected ? "selected" : undefined}
      className={cn(
        "group/card flex min-w-0 items-center gap-3 px-4 py-3 transition-colors duration-(--motion-fast)",
        "hover:bg-surface-muted/60 active:bg-surface-muted focus-ring-inset data-[state=selected]:bg-accent-soft/50",
        className,
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex min-w-0 items-start justify-between gap-3">
          <span className="min-w-0 truncate font-medium text-ink">{row.name}</span>
          <DueChip due={row.dueDate} timeZone={timeZone} done={deadlineSettled(row)} compact className="shrink-0" />
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-muted">
          <span className="shrink-0 font-mono numeric">{row.jobNumber}</span>
          <span aria-hidden="true">·</span>
          <span className="truncate">{row.client.name}</span>
          {people.length > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">{people.join(" → ")}</span>
            </>
          ) : null}
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          <StatusPill status={row.status} size="xs" />
          <PriorityPill priority={row.priority} size="sm" quietNormal />
          <RevisionCount count={row.revisionCount} />
          {row.isPaused ? <PausedChip timeZone={timeZone} /> : null}
        </span>
      </span>
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-subtle transition-transform group-hover/card:translate-x-0.5" />
    </Link>
  );
}
