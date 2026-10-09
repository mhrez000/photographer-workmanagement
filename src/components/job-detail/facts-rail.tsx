import * as React from "react";
import { CircleCheck, CircleX, FolderOpen, Fingerprint, CalendarDays, Gauge } from "lucide-react";
import { SectionCard } from "@/components/common";
import { ElapsedClock, ExternalLinkButton, PersonChip } from "@/components/jobs";
import { Progress } from "@/components/ui/progress";
import { LINK_KIND_META, STATUS_CATEGORY_META, type StatusCategory } from "@/lib/constants";
import { formatDate, formatDateTime } from "@/lib/dates";
import type { JobDetail, UserRef } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatSeconds } from "./format";

/* ------------------------------------------------------------------ */
/*  Small building blocks                                              */
/* ------------------------------------------------------------------ */

function Fact({ label, children, className }: { label: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("grid grid-cols-[112px_minmax(0,1fr)] items-baseline gap-3 py-2", className)}>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-sm text-ink">{children}</dd>
    </div>
  );
}

function When({ value, timeZone, by }: { value: string | null; timeZone: string; by?: UserRef | null }) {
  if (!value) return <span className="text-ink-subtle">—</span>;
  return (
    <span className="flex flex-col">
      <time dateTime={value} className="numeric">
        {formatDateTime(value, timeZone)}
      </time>
      {by ? <span className="text-xs text-ink-muted">by {by.name}</span> : null}
    </span>
  );
}

function Civil({ value, timeZone }: { value: string | null; timeZone: string }) {
  if (!value) return <span className="text-ink-subtle">Not set</span>;
  return (
    <time dateTime={value} className="numeric">
      {formatDate(value, timeZone)}
    </time>
  );
}

/* ------------------------------------------------------------------ */
/*  Derivations                                                        */
/* ------------------------------------------------------------------ */

interface EditorStint {
  user: UserRef;
  from: string;
  to: string | null;
  isCurrent: boolean;
  reason: string | null;
}

/** Every editor who held the job, oldest first (one row per assignment). */
function editorStints(detail: JobDetail): EditorStint[] {
  return detail.assignments
    .filter((a) => a.role === "editor")
    .map((a) => ({ user: a.user, from: a.assignedAt, to: a.unassignedAt, isCurrent: a.isCurrent, reason: a.unassignReason }));
}

const REVIEW_CATEGORIES: readonly StatusCategory[] = ["review", "revision", "approved"];

/** People who reviewed: actors who began review, requested a revision or approved. */
function reviewers(detail: JobDetail): UserRef[] {
  const out = new Map<string, UserRef>();
  for (const s of detail.stages) {
    if (s.kind !== "transition" || !s.actor) continue;
    if (!REVIEW_CATEGORIES.includes(s.toCategory)) continue;
    if (s.fromCategory && !STATUS_CATEGORY_META[s.fromCategory].reviewerHolds && s.toCategory !== "approved") continue;
    out.set(s.actor.id, s.actor);
  }
  if (detail.job.approvedBy) out.set(detail.job.approvedBy.id, detail.job.approvedBy);
  return [...out.values()];
}

/* ------------------------------------------------------------------ */
/*  Rail                                                               */
/* ------------------------------------------------------------------ */

export interface FactsRailProps {
  detail: JobDetail;
  timeZone: string;
  /** Viewer id — their running timer shows live. */
  viewerId: string | null;
  timeTrackingEnabled: boolean;
}

/**
 * Right-hand rail answering spec §34 without hunting: who worked on it, when it
 * started, was submitted, reviewed, revised, approved (on time?), completed,
 * and where the finished work is — plus key dates and effort.
 */
export function FactsRail({ detail, timeZone, viewerId, timeTrackingEnabled }: FactsRailProps) {
  const { job, metrics, revisions, finishedWork } = detail;
  const stints = editorStints(detail);
  const reviewedBy = reviewers(detail);
  const latestRevision = revisions.length > 0 ? revisions[revisions.length - 1] : null;
  const running = detail.runningSession;
  const ownRunning = running && running.isRunning && running.user.id === viewerId ? running : null;
  const primaryFinished = finishedWork[0] ?? null;
  const onTime = job.wasOnTime;

  return (
    <div className="flex flex-col gap-4">
      <SectionCard eyebrow="Traceability" title="Who did what, when" as="h2">
        <dl className="-my-2 divide-y divide-border">
          <Fact label="Worked on by">
            {stints.length === 0 ? (
              <span className="text-ink-subtle">No editor yet</span>
            ) : (
              <ul className="flex flex-col gap-2">
                {stints.map((s, i) => (
                  <li key={`${s.user.id}-${i}`} className="flex flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      <PersonChip user={s.user} size="xs" />
                      {s.isCurrent ? <span className="rounded-full bg-accent-soft px-1.5 text-2xs font-medium text-accent-ink">current</span> : null}
                    </span>
                    <span className="pl-7 text-xs text-ink-muted numeric">
                      {formatDate(s.from, timeZone)} → {s.to ? formatDate(s.to, timeZone) : "now"}
                      {s.reason && !s.isCurrent ? ` · ${s.reason.replace(/_/g, " ")}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Fact>
          <Fact label="Started">
            <When value={job.startedAt} timeZone={timeZone} />
          </Fact>
          <Fact label="Submitted">
            {job.firstSubmittedAt ? (
              <span className="flex flex-col">
                <span className="numeric">First {formatDateTime(job.firstSubmittedAt, timeZone)}</span>
                {job.lastSubmittedAt && job.lastSubmittedAt !== job.firstSubmittedAt ? (
                  <span className="text-xs text-ink-muted numeric">Last {formatDateTime(job.lastSubmittedAt, timeZone)}</span>
                ) : null}
              </span>
            ) : (
              <span className="text-ink-subtle">Not yet</span>
            )}
          </Fact>
          <Fact label="Reviewed by">
            {reviewedBy.length === 0 ? (
              <span className="text-ink-subtle">Not reviewed yet</span>
            ) : (
              <span className="flex flex-wrap gap-x-3 gap-y-1">
                {reviewedBy.map((u) => (
                  <PersonChip key={u.id} user={u} size="xs" />
                ))}
              </span>
            )}
          </Fact>
          <Fact label="Revisions">
            {revisions.length === 0 ? (
              <span className="text-ink-subtle">None</span>
            ) : (
              <span className="flex flex-col">
                <span className="numeric font-medium">{revisions.length}</span>
                {latestRevision ? (
                  <span className="text-xs text-ink-muted">
                    Latest #{latestRevision.revisionNumber}: {latestRevision.reason}
                    {latestRevision.isOpen ? " (open)" : ""}
                  </span>
                ) : null}
              </span>
            )}
          </Fact>
          <Fact label="Approved">
            {job.approvedAt ? (
              <span className="flex flex-col gap-0.5">
                <When value={job.approvedAt} timeZone={timeZone} by={job.approvedBy} />
                {onTime !== null ? (
                  <span className={cn("inline-flex items-center gap-1 text-xs font-medium", onTime ? "text-success-fg" : "text-danger-fg")}>
                    {onTime ? <CircleCheck aria-hidden="true" className="size-3.5" /> : <CircleX aria-hidden="true" className="size-3.5" />}
                    {onTime ? "On time" : "Late"}
                    {job.dueDateAtApproval ? <span className="font-normal text-ink-muted">· due {formatDate(job.dueDateAtApproval, timeZone)}</span> : null}
                  </span>
                ) : (
                  <span className="text-xs text-ink-muted">No due date at approval</span>
                )}
              </span>
            ) : (
              <span className="text-ink-subtle">Not yet</span>
            )}
          </Fact>
          <Fact label="Delivered">
            <When value={job.deliveredAt} timeZone={timeZone} />
          </Fact>
          <Fact label="Completed">
            {job.completedAt ? <When value={job.completedAt} timeZone={timeZone} /> : job.cancelledAt ? <span className="text-ink-muted">Cancelled {formatDate(job.cancelledAt, timeZone)}</span> : <span className="text-ink-subtle">Not yet</span>}
          </Fact>
          <Fact label={<span className="inline-flex items-center gap-1"><FolderOpen aria-hidden="true" className="size-3.5" />Finished work</span>}>
            {primaryFinished ? (
              <span className="flex flex-col gap-1.5">
                <ExternalLinkButton url={primaryFinished.url} label={primaryFinished.label ?? LINK_KIND_META[primaryFinished.kind].label} provider={primaryFinished.provider} hideHost className="w-full" />
                {finishedWork.length > 1 ? <span className="text-xs text-ink-muted">+{finishedWork.length - 1} more in Finished work</span> : null}
              </span>
            ) : (
              <span className="text-ink-subtle">No finished link yet</span>
            )}
          </Fact>
        </dl>
      </SectionCard>

      <SectionCard eyebrow={<span className="inline-flex items-center gap-1"><CalendarDays aria-hidden="true" className="size-3" />Key dates</span>} as="h2">
        <dl className="-my-2 divide-y divide-border">
          <Fact label="Created">
            <When value={job.createdAt} timeZone={timeZone} by={job.createdBy} />
          </Fact>
          <Fact label="Shoot">
            <Civil value={job.shootDate} timeZone={timeZone} />
          </Fact>
          <Fact label="Due">
            <Civil value={job.dueDate} timeZone={timeZone} />
          </Fact>
          <Fact label="Review due">
            <Civil value={job.reviewDueDate} timeZone={timeZone} />
          </Fact>
          <Fact label="Delivery due">
            <Civil value={job.deliveryDueDate} timeZone={timeZone} />
          </Fact>
          <Fact label="Completion">
            <Civil value={job.completedAt} timeZone={timeZone} />
          </Fact>
        </dl>
      </SectionCard>

      <SectionCard eyebrow={<span className="inline-flex items-center gap-1"><Gauge aria-hidden="true" className="size-3" />Effort</span>} as="h2">
        <dl className="-my-2 divide-y divide-border">
          <Fact label="Progress">
            <span className="flex items-center gap-2">
              <Progress value={job.completionPercent} size="sm" tone={job.completionPercent >= 100 ? "success" : "accent"} className="flex-1" label="Completion" />
              <span className="numeric text-xs text-ink-muted">{job.completionPercent}%</span>
            </span>
          </Fact>
          <Fact label="Estimated">
            <span className="numeric">{job.estimatedHours != null ? `${job.estimatedHours} h` : <span className="text-ink-subtle">Type default</span>}</span>
          </Fact>
          <Fact label="Job type">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: job.jobType.colour }} />
              {job.jobType.name}
            </span>
          </Fact>
          <Fact label="In status">
            <span className="numeric">{formatSeconds(metrics.timeInCurrentStatusSeconds)}</span>
          </Fact>
          <Fact label="Editing time">
            <span className="numeric">{formatSeconds(metrics.editingSeconds)}</span>
            {metrics.activeEditingSeconds !== null ? (
              <span className="ml-1 text-xs text-ink-muted numeric">({formatSeconds(metrics.activeEditingSeconds)} tracked)</span>
            ) : null}
          </Fact>
          <Fact label="Review time">
            <span className="numeric">{formatSeconds(metrics.reviewSeconds)}</span>
          </Fact>
          {metrics.turnaroundSeconds !== null ? (
            <Fact label="Turnaround">
              <span className="numeric">{formatSeconds(metrics.turnaroundSeconds)}</span>
            </Fact>
          ) : null}
          {timeTrackingEnabled || running ? (
            <Fact label="Timer">
              {running ? (
                <span className="flex flex-col">
                  <span className="inline-flex items-center gap-1.5 font-medium text-success-fg">
                    <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-success" />
                    <ElapsedClock startedAt={running.startedAt} />
                  </span>
                  <span className="text-xs text-ink-muted">{ownRunning ? "Your timer" : running.user.name} · {running.statusName}</span>
                </span>
              ) : (
                <span className="text-ink-subtle">Not running</span>
              )}
            </Fact>
          ) : null}
        </dl>
        <p className="mt-3 flex items-center gap-1.5 text-2xs text-ink-subtle">
          <Fingerprint aria-hidden="true" className="size-3" />
          Version {job.version} · updated {formatDateTime(job.updatedAt, timeZone)}
        </p>
      </SectionCard>
    </div>
  );
}
