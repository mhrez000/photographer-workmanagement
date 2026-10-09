import * as React from "react";
import Link from "next/link";
import { ArrowRight, Check, FileText, Link2, MessageSquareReply, RotateCcw, CircleSlash } from "lucide-react";
import { SectionCard } from "@/components/common";
import { DueChip, ExternalLinkButton, PersonChip, PriorityPill } from "@/components/jobs";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CATEGORY_GROUPS, LINK_KIND_META, NOTE_KIND_META, NOTE_KINDS, type NoteKind, type StatusCategory } from "@/lib/constants";
import { formatDateTime } from "@/lib/dates";
import type { JobDetail, NoteView, RevisionView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FinishedWorkPanel } from "./finished-work";
import { formatSeconds, slotKind, STAGE_LABELS, STAGES, stageOf, stageTotalsFromCategories } from "./format";

/* ------------------------------------------------------------------ */
/*  Stage stepper                                                      */
/* ------------------------------------------------------------------ */

/** Index of the job's current stage in STAGES (-1 = none, e.g. cancelled; STAGES.length = completed). */
function currentStageIndex(category: StatusCategory): number {
  if (category === "completed") return STAGES.length;
  const stage = stageOf(category);
  return stage === null ? -1 : STAGES.indexOf(stage);
}

/**
 * One step per production stage (Assignment → Editing → Review → Revision →
 * Approval → Delivery), with the same per-stage totals as the Timeline tab
 * (`stageTotalsFromCategories`). Revision is its own step and is shown as
 * skipped when the job never had one. Three columns on narrow containers so
 * labels never collide.
 */
function StageStepper({ detail }: { detail: JobDetail }) {
  const { job, metrics } = detail;
  const cancelled = job.statusCategory === "cancelled";
  const current = currentStageIndex(job.statusCategory);
  const totals = stageTotalsFromCategories(metrics.secondsPerCategory);
  const hadRevision = detail.revisions.length > 0 || totals.revision > 0;

  return (
    <div className="@container">
      <ol aria-label="Production stages" className={cn("grid grid-cols-3 gap-x-1.5 gap-y-3 @xl:grid-cols-6", cancelled && "opacity-60")}>
        {STAGES.map((stage, i) => {
          const skipped = stage === "revision" && !hadRevision && i !== current;
          const done = i < current && !skipped;
          const active = i === current && !cancelled;
          const spent = totals[stage];
          const label = STAGE_LABELS[stage];
          const time = spent > 0 ? formatSeconds(spent) : skipped && i < current ? "None" : null;
          return (
            <li
              key={stage}
              aria-current={active ? "step" : undefined}
              title={time ? `${label} · ${time}` : label}
              className="flex min-w-0 flex-col gap-1.5"
            >
              <span
                className={cn(
                  "h-1.5 rounded-full transition-colors",
                  done ? "bg-accent" : active ? "bg-accent/60 animate-pulse" : "bg-surface-muted ring-1 ring-inset ring-border",
                  active && stage === "revision" && "bg-status-revision/70",
                )}
              />
              <span className={cn("flex min-w-0 items-center gap-1 text-xs", active ? "font-medium text-ink" : done ? "text-ink-secondary" : "text-ink-subtle")}>
                {done ? <Check aria-hidden="true" className="size-3 shrink-0 text-accent-ink" /> : null}
                <span className="min-w-0 truncate">{label}</span>
              </span>
              <span className="truncate text-2xs text-ink-subtle numeric">{time ?? "\u00a0"}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Open revision callout                                              */
/* ------------------------------------------------------------------ */

function OpenRevisionCallout({ revision, timeZone, jobId, canRespond }: { revision: RevisionView; timeZone: string; jobId: string; canRespond: boolean }) {
  return (
    <Card tone="danger" className="overflow-hidden">
      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-status-revision text-white">
              <RotateCcw aria-hidden="true" className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="eyebrow text-status-revision-fg">Open revision</p>
              <h2 className="text-md font-semibold text-ink">
                Revision #{revision.revisionNumber} — {revision.reason}
              </h2>
              <p className="mt-0.5 text-xs text-ink-muted">
                Requested by {revision.requestedBy.name} · {formatDateTime(revision.requestedAt, timeZone)}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <PriorityPill priority={revision.priority} quietNormal />
            {revision.dueDate ? <DueChip due={revision.dueDate} timeZone={timeZone} kind="Revision due" /> : null}
          </div>
        </div>
        <p className="whitespace-pre-wrap text-sm text-ink-secondary">{revision.description}</p>
        {revision.instructions ? (
          <div className="rounded-md border border-status-revision/20 bg-surface p-3">
            <p className="eyebrow mb-1">Instructions</p>
            <p className="whitespace-pre-wrap text-sm text-ink">{revision.instructions}</p>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PersonChip user={revision.assignee} label="Assigned to" emptyLabel="No assignee" />
          <div className="flex flex-wrap gap-2">
            <Button href={`/jobs/${jobId}?tab=revisions`} variant="ghost" size="sm" trailingIcon={<ArrowRight aria-hidden="true" />}>
              All revisions
            </Button>
            {canRespond ? (
              <Button href={`/jobs/${jobId}?tab=comments&respond=${revision.id}`} variant="outline" size="sm" leadingIcon={<MessageSquareReply aria-hidden="true" />}>
                Respond
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Notes summary                                                      */
/* ------------------------------------------------------------------ */

function NotesSummary({ notes, readableKinds, jobId }: { notes: NoteView[]; readableKinds: NoteKind[]; jobId: string }) {
  const active = notes.filter((n) => n.archivedAt === null);
  const kinds = NOTE_KINDS.filter((k) => readableKinds.includes(k) && active.some((n) => n.kind === k));
  return (
    <SectionCard
      title="Notes"
      description="Structured notes by kind — pinned first."
      actions={
        <Button href={`/jobs/${jobId}?tab=notes`} variant="ghost" size="sm" trailingIcon={<ArrowRight aria-hidden="true" />}>
          Open notes
        </Button>
      }
    >
      {kinds.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-ink-muted">
          <FileText aria-hidden="true" className="size-4 text-ink-subtle" />
          No notes yet. Photographer, editor and client notes will show here.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {kinds.map((kind) => {
            const ofKind = active.filter((n) => n.kind === kind);
            const lead = ofKind[0];
            return (
              <li key={kind}>
                <Link
                  href={`/jobs/${jobId}?tab=notes&kind=${kind}`}
                  className="group flex h-full flex-col gap-1.5 rounded-md border border-border bg-surface-sunken/60 p-3 transition-colors hover:border-border-hover hover:bg-surface focus-ring"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="eyebrow">{NOTE_KIND_META[kind].label}</span>
                    <span className="numeric text-2xs text-ink-subtle">{ofKind.length}</span>
                  </span>
                  <span className="line-clamp-3 whitespace-pre-wrap text-sm text-ink-secondary group-hover:text-ink">{lead.body}</span>
                  <span className="mt-auto text-2xs text-ink-subtle">— {lead.author.name}{lead.isPinned ? " · pinned" : ""}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Overview                                                           */
/* ------------------------------------------------------------------ */

export interface OverviewTabProps {
  detail: JobDetail;
  timeZone: string;
  readableNoteKinds: NoteKind[];
}

/** Overview: finished work (prominent once done), open revision, stages, description, notes, links. */
export function OverviewTab({ detail, timeZone, readableNoteKinds }: OverviewTabProps) {
  const { job, finishedWork, links, openRevision, actions } = detail;
  const done = CATEGORY_GROUPS.DONE.includes(job.statusCategory);
  const canAddFinished = actions.canAddLinkKinds.some((k) => LINK_KIND_META[k].finishedWork);
  const addHref = `/jobs/${job.id}?tab=links`;
  const otherLinks = links.filter((s) => s.current && !LINK_KIND_META[slotKind(s)].finishedWork);
  const finished = (
    <FinishedWorkPanel links={finishedWork} slots={links} timeZone={timeZone} prominent={done} canAdd={canAddFinished} addHref={addHref} />
  );

  return (
    <div className="flex flex-col gap-5">
      {job.statusCategory === "cancelled" ? (
        <Card tone="muted" className="flex flex-row items-center gap-3 p-4 text-sm text-ink-secondary">
          <CircleSlash aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
          This job was cancelled{job.cancelledAt ? ` on ${formatDateTime(job.cancelledAt, timeZone)}` : ""}. Its history is kept in full.
        </Card>
      ) : null}

      {done ? finished : null}
      {openRevision ? <OpenRevisionCallout revision={openRevision} timeZone={timeZone} jobId={job.id} canRespond={actions.canComment} /> : null}

      <SectionCard title="Progress" description={`Currently ${job.status.name.toLowerCase()} · ${job.completionPercent}% complete`}>
        <StageStepper detail={detail} />
      </SectionCard>

      <SectionCard title="Brief">
        {job.description ? (
          <p className="whitespace-pre-wrap text-base leading-relaxed text-ink-secondary">{job.description}</p>
        ) : (
          <p className="text-sm text-ink-muted">No description was added for this job.</p>
        )}
      </SectionCard>

      {!done && finishedWork.length > 0 ? finished : null}

      <NotesSummary notes={detail.notes} readableKinds={readableNoteKinds} jobId={job.id} />

      <SectionCard
        title="Working links"
        description="Raw files, editing workspace and references."
        actions={
          <Button href={addHref} variant="ghost" size="sm" trailingIcon={<ArrowRight aria-hidden="true" />}>
            All links
          </Button>
        }
      >
        {otherLinks.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-ink-muted">
            <Link2 aria-hidden="true" className="size-4 text-ink-subtle" />
            No working links yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {otherLinks.map((slot) =>
              slot.current ? (
                <li key={slot.current.id} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <span className="text-xs text-ink-muted sm:w-36 sm:shrink-0">{LINK_KIND_META[slotKind(slot)].label}</span>
                  <ExternalLinkButton url={slot.current.url} label={slot.current.label} provider={slot.current.provider} variant="ghost" className="sm:flex-1" />
                </li>
              ) : null,
            )}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
