import * as React from "react";
import { Info, Pencil } from "lucide-react";
import { CopyButton } from "@/components/common";
import { DueChip, JobActionBar, PausedChip, PersonChip, PriorityPill, RevisionCount, StatusPill, TimeInStatus } from "@/components/jobs";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { STATUS_CATEGORY_META } from "@/lib/constants";
import { daysRemaining, describeDue, formatDateTime } from "@/lib/dates";
import type { DeliverContext } from "@/lib/sharing";
import type { JobDetail, UserRef } from "@/lib/types";
import { cn } from "@/lib/utils";
import { showsDaysRemaining } from "./format";

export interface JobHeaderProps {
  detail: JobDetail;
  timeZone: string;
  /** Owners / managers: "Move to any status…" in the action menu. */
  canOverride: boolean;
  /** People chips link to the person page (management only). */
  linkPeople: boolean;
  /** The viewer (their own running timer drives the timer control). */
  viewerId: string | null;
  /** Org setting `time_tracking_enabled`. */
  timeTrackingEnabled: boolean;
  /** Client sharing facts for the Deliver dialog (ROLES.md §7.3); null = plain delivery. */
  deliver?: DeliverContext | null;
  /** Shown under the actions when someone else reviews this job (ROLES.md §4.4). */
  reviewHint?: string | null;
}

/** "12 days left" next to a due chip that shows a plain date (never for overdue / today / soon). */
function DaysRemaining({ due, timeZone }: { due: string; timeZone: string }) {
  const days = daysRemaining(due, timeZone);
  if (days === null || days < 0) return null;
  return (
    <span className="numeric text-xs text-ink-muted" title={`Due ${formatDateTime(due, timeZone)}`}>
      {days} {days === 1 ? "day" : "days"} left
    </span>
  );
}

function personHref(user: UserRef | null, link: boolean): string | undefined {
  return link && user ? `/team/users/${user.id}` : undefined;
}

/**
 * Job detail header (spec §38): number, name, status, priority, due date with
 * days remaining, paused state, people, client › project breadcrumb and the
 * next-step actions. Sticky on desktop; on phones the action bar docks above
 * the tab bar so it stays within thumb reach.
 */
export function JobHeader({ detail, timeZone, canOverride, linkPeople, viewerId, timeTrackingEnabled, deliver = null, reviewHint = null }: JobHeaderProps) {
  const { job, actions, runningSession } = detail;
  const meta = STATUS_CATEGORY_META[job.statusCategory];
  const finished = job.statusCategory === "completed" ? job.completedAt : null;
  const ownRunning = runningSession && runningSession.isRunning && runningSession.user.id === viewerId ? runningSession : null;

  return (
    <div className="border-b border-border pb-4 lg:sticky lg:bg-canvas/95 lg:backdrop-blur lg:supports-[backdrop-filter]:bg-canvas/85 lg:top-(--topbar-height) lg:z-(--z-page-sticky) lg:-mx-8 lg:px-8 lg:pt-1">
      <PageHeader
        eyebrow={[
          { label: "Jobs", href: "/jobs" },
          { label: job.client.name, href: `/clients/${job.client.id}` },
          { label: job.project.name, href: `/projects/${job.project.id}` },
        ]}
        title={
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-lg font-medium text-ink-muted numeric">{job.jobNumber}</span>
            <span className="min-w-0 break-words">{job.name}</span>
          </span>
        }
        actions={
          <>
            <CopyButton value={job.jobNumber} label="Copy ID" ariaLabel={`Copy job number ${job.jobNumber}`} successMessage={`${job.jobNumber} copied`} size="sm" variant="ghost" />
            {actions.canEditFields ? (
              <Button href={`/jobs/${job.id}/edit`} variant="outline" size="sm" leadingIcon={<Pencil aria-hidden="true" />} aria-keyshortcuts="e">
                Edit
              </Button>
            ) : null}
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
          <StatusPill status={job.status} />
          <PriorityPill priority={job.priority} size="md" />
          <span className="inline-flex items-center gap-1.5">
            <DueChip due={job.dueDate} timeZone={timeZone} completedAt={finished} done={meta.done} />
            {/* The chip already says overdue / due today / due soon; days left only adds to a plain date. */}
            {job.dueDate && !meta.done && meta.open && showsDaysRemaining(describeDue(job.dueDate, timeZone).tone) ? (
              <DaysRemaining due={job.dueDate} timeZone={timeZone} />
            ) : null}
          </span>
          {job.isPaused ? <PausedChip pausedAt={job.pausedAt} timeZone={timeZone} /> : null}
          {job.revisionCount > 0 ? <RevisionCount count={job.revisionCount} /> : null}
          <span className="hidden h-4 w-px bg-border sm:inline-block" aria-hidden="true" />
          <TimeInStatus seconds={detail.metrics.timeInCurrentStatusSeconds} suffix={`in ${job.status.name}`} warnAfterHours={24} alertAfterHours={72} />
        </div>

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <PersonChip user={job.photographer} label="Photographer" emptyLabel="No photographer" href={personHref(job.photographer, linkPeople)} />
            <PersonChip user={job.editor} label="Editor" emptyLabel="Unassigned" href={personHref(job.editor, linkPeople)} />
            {job.previousEditor && job.previousEditor.id !== job.editor?.id ? (
              <PersonChip user={job.previousEditor} label="Previous editor" size="xs" className="opacity-80" href={personHref(job.previousEditor, linkPeople)} />
            ) : null}
          </div>

          {/* Phones: pinned above the tab bar. Desktop: inline in the sticky header. */}
          <div
            className={cn(
              "max-lg:fixed max-lg:inset-x-0 max-lg:z-(--z-shell) max-lg:border-t max-lg:border-border max-lg:bg-surface/95 max-lg:px-4 max-lg:py-2.5 max-lg:shadow-pop max-lg:backdrop-blur",
              "max-lg:bottom-[calc(var(--tabbar-height)+env(safe-area-inset-bottom,0px))]",
            )}
          >
            <JobActionBar
              jobId={job.id}
              version={job.version}
              actions={actions}
              job={{
                statusCategory: job.statusCategory,
                isPaused: job.isPaused,
                editor: job.editor,
                photographer: job.photographer,
                statusId: job.status.id,
                jobNumber: job.jobNumber,
                name: job.name,
              }}
              timeTrackingEnabled={timeTrackingEnabled}
              runningSession={ownRunning ? { id: ownRunning.id, startedAt: ownRunning.startedAt } : null}
              timeZone={timeZone}
              workflowStatuses={canOverride ? detail.workflowStatuses : undefined}
              canOverride={canOverride}
              deliver={deliver}
            />
            {reviewHint ? (
              <p className="mt-2 flex items-center gap-1.5 text-sm text-ink-muted lg:justify-end">
                <Info aria-hidden="true" className="size-4 shrink-0" />
                {reviewHint}
              </p>
            ) : null}
          </div>
        </div>
      </PageHeader>
    </div>
  );
}
