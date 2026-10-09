import * as React from "react";
import Link from "next/link";
import { Pin, StickyNote } from "lucide-react";
import { DueChip, ExternalLinkButton, JobQuickActions, PausedChip, PersonChip, PriorityPill, RevisionCount, StatusPill, TimeInStatus, jobHref } from "@/components/jobs";
import { NOTE_KIND_META, type Role } from "@/lib/constants";
import type { JobRow, WorkSessionView } from "@/lib/types";
import type { MyWorkNotePreview } from "@/server/queries/myWork";
import { cn, truncate } from "@/lib/utils";
import { SECTION_TONE_CLASSES, type MyWorkPerspective, type SectionTone } from "./sections";

export interface WorkCardProps {
  job: JobRow;
  viewer: { id: string; role: Role };
  perspective: MyWorkPerspective;
  timeZone: string;
  timeTrackingEnabled: boolean;
  /** The viewer's running session when it runs on this job. */
  runningSession: Pick<WorkSessionView, "id" | "startedAt"> | null;
  note: MyWorkNotePreview | null;
  /** Section tone — overdue / due-today cards get a coloured rail. */
  tone: SectionTone;
}

/** Hours in one status after which the card's time-in-status tones up. */
const STALL_WARN_HOURS = 24;
const STALL_ALERT_HOURS = 72;

/**
 * One job in the My Work queue (server component). Summary first: name,
 * client, the people involved, due / priority / status chips, how long it has
 * sat in this status, revisions, the work link and the latest note. The quick
 * actions are a client island so Start → Submit → Complete is one click each.
 */
export function WorkCard({ job, viewer, perspective, timeZone, timeTrackingEnabled, runningSession, note, tone }: WorkCardProps) {
  const railed = tone === "danger" || tone === "attention";
  const counterpart = perspective === "editor" ? job.photographer : job.editor;
  const counterpartLabel = perspective === "editor" ? "Photographer" : "Editor";
  const timerRunning = runningSession !== null;

  return (
    <li>
      <article
        aria-labelledby={`job-${job.id}-name`}
        className={cn(
          "group/card relative overflow-hidden rounded-lg border bg-surface shadow-xs",
          "transition-[border-color,box-shadow] duration-(--motion-base) ease-out-soft hover:border-border-hover hover:shadow-sm",
          timerRunning ? "border-success/40" : "border-border",
        )}
      >
        {railed ? <span aria-hidden="true" className={cn("absolute inset-y-0 left-0 w-1", SECTION_TONE_CLASSES[tone].rail)} /> : null}
        <div className={cn("flex flex-col gap-3 p-4 md:flex-row md:items-start md:gap-6", railed && "pl-5")}>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-ink-muted">
              <span className="shrink-0 font-mono numeric">{job.jobNumber}</span>
              <span aria-hidden="true" className="text-ink-subtle">
                ·
              </span>
              <span className="truncate">
                {job.client.name}
                {job.project.name && !job.name.startsWith(job.project.name) ? <span className="text-ink-subtle"> / {job.project.name}</span> : null}
              </span>
            </div>
            <h3 id={`job-${job.id}-name`} className="mt-0.5 text-md font-semibold leading-6 text-ink">
              <Link href={jobHref(job.id)} className="rounded-xs underline-offset-2 hover:underline focus-ring">
                {job.name}
              </Link>
            </h3>

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <StatusPill status={job.status} size="sm" />
              <DueChip due={job.dueDate} timeZone={timeZone} />
              <PriorityPill priority={job.priority} quietNormal />
              <RevisionCount count={job.revisionCount} icon />
              {job.isPaused ? <PausedChip timeZone={timeZone} /> : null}
              <TimeInStatus
                seconds={job.timeInStatusSeconds}
                since={job.statusEnteredAt}
                timeZone={timeZone}
                warnAfterHours={STALL_WARN_HOURS}
                alertAfterHours={STALL_ALERT_HOURS}
                className="ml-0.5"
              />
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
              <PersonChip user={counterpart} label={counterpartLabel} size="xs" />
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-muted">
                <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: job.jobType.colour }} />
                <span className="truncate">{job.jobType.name}</span>
                {job.estimatedHours !== null ? <span className="numeric text-ink-subtle">· {formatHours(job.estimatedHours)} est.</span> : null}
              </span>
            </div>

            {note ? (
              <p className="mt-3 flex items-start gap-2 rounded-md bg-surface-sunken px-3 py-2 text-sm text-ink-secondary">
                {note.isPinned ? (
                  <Pin aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-ink-subtle" />
                ) : (
                  <StickyNote aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-ink-subtle" />
                )}
                <span className="min-w-0">
                  <span className="mr-1.5 text-xs font-medium text-ink-muted">{NOTE_KIND_META[note.kind].label}</span>
                  <span className="line-clamp-2 break-words">{truncate(note.body, 280)}</span>
                </span>
              </p>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-col gap-2 border-t border-border pt-3 md:w-60 md:items-end md:border-t-0 md:pt-0">
            {job.primaryLink ? (
              <ExternalLinkButton
                url={job.primaryLink.url}
                label={job.primaryLink.label}
                size="sm"
                variant="outline"
                hideHost
                className="w-full md:w-auto md:max-w-full"
              />
            ) : (
              <span className="hidden text-xs text-ink-subtle md:inline">No work link yet</span>
            )}
            <JobQuickActions
              job={job}
              viewer={viewer}
              timeTrackingEnabled={timeTrackingEnabled}
              runningSession={runningSession}
              timeZone={timeZone}
              className="md:flex md:justify-end"
            />
          </div>
        </div>
      </article>
    </li>
  );
}

function formatHours(hours: number): string {
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}
