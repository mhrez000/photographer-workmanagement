import * as React from "react";
import Link from "next/link";
import { CircleCheck, CircleDot, CircleSlash, MessageSquare, RotateCcw, Undo2 } from "lucide-react";
import { DueChip, PersonChip, PriorityPill } from "@/components/jobs";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDateTime } from "@/lib/dates";
import type { CommentNode, RevisionView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { clip, formatSeconds } from "./format";
import { RevisionActions } from "./revision-actions";

const RESOLUTION: Record<NonNullable<RevisionView["resolution"]>, { label: string; variant: "success" | "neutral" | "info"; icon: typeof CircleCheck }> = {
  resubmitted: { label: "Resubmitted", variant: "info", icon: CircleCheck },
  approved: { label: "Approved", variant: "success", icon: CircleCheck },
  withdrawn: { label: "Withdrawn", variant: "neutral", icon: Undo2 },
  cancelled: { label: "Cancelled", variant: "neutral", icon: CircleSlash },
};

function flatten(nodes: readonly CommentNode[]): CommentNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.replies)]);
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-2xs font-medium uppercase tracking-wide text-ink-subtle">{label}</dt>
      <dd className="min-w-0 text-sm text-ink">{children}</dd>
    </div>
  );
}

export interface RevisionsTabProps {
  jobId: string;
  jobVersion: number;
  revisions: RevisionView[];
  comments: CommentNode[];
  timeZone: string;
  /** Owners / managers / the job's photographer may edit the open revision. */
  canEditOpen: boolean;
  canWithdraw: boolean;
  canRespond: boolean;
}

/** Numbered revision cards (#3, #2, #1 — never overwritten), newest first (spec §17). */
export function RevisionsTab({ jobId, jobVersion, revisions, comments, timeZone, canEditOpen, canWithdraw, canRespond }: RevisionsTabProps) {
  if (revisions.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={RotateCcw}
          title="No revisions requested"
          description="When a reviewer sends work back, each request is numbered here — Revision #1, #2, #3 — with the reason, instructions and how it was resolved."
        />
      </Card>
    );
  }

  const all = flatten(comments);
  const ordered = [...revisions].sort((a, b) => b.revisionNumber - a.revisionNumber);

  return (
    <ol className="flex flex-col gap-4" aria-label="Revisions, newest first">
      {ordered.map((r) => {
        const linked = all.filter((c) => c.revisionId === r.id);
        const res = r.resolution ? RESOLUTION[r.resolution] : null;
        return (
          <li key={r.id}>
            <Card tone={r.isOpen ? "danger" : "default"} className={cn("overflow-hidden", !r.isOpen && "shadow-none")}>
              <div className="flex flex-col gap-4 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <span
                      className={cn(
                        "flex size-11 shrink-0 flex-col items-center justify-center rounded-lg font-semibold leading-none numeric",
                        r.isOpen ? "bg-status-revision text-white" : "bg-surface-muted text-ink-secondary ring-1 ring-inset ring-border",
                      )}
                      aria-hidden="true"
                    >
                      <span className="text-2xs font-medium opacity-80">#</span>
                      <span className="text-lg">{r.revisionNumber}</span>
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-md font-semibold text-ink">
                        Revision #{r.revisionNumber} <span className="font-normal text-ink-muted">— {r.reason}</span>
                      </h3>
                      <p className="mt-0.5 text-xs text-ink-muted">
                        Requested by {r.requestedBy.name} ·{" "}
                        <time dateTime={r.requestedAt} className="numeric">
                          {formatDateTime(r.requestedAt, timeZone)}
                        </time>
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {r.isOpen ? (
                      <Badge variant="danger" size="sm">
                        <CircleDot aria-hidden="true" /> Open
                      </Badge>
                    ) : res ? (
                      <Badge variant={res.variant} size="sm">
                        <res.icon aria-hidden="true" /> {res.label}
                      </Badge>
                    ) : null}
                    <PriorityPill priority={r.priority} />
                  </div>
                </div>

                <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-secondary">{r.description}</p>

                {r.instructions ? (
                  <div className={cn("rounded-md border p-3", r.isOpen ? "border-status-revision/20 bg-surface" : "border-border bg-surface-sunken/70")}>
                    <p className="eyebrow mb-1">Instructions</p>
                    <p className="whitespace-pre-wrap text-sm text-ink">{r.instructions}</p>
                  </div>
                ) : null}

                <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-4 sm:grid-cols-4">
                  <Meta label="Assigned to">
                    <PersonChip user={r.assignee} size="xs" emptyLabel="No assignee" />
                  </Meta>
                  <Meta label="Due">
                    {r.dueDate ? <DueChip due={r.dueDate} timeZone={timeZone} kind="Revision due" done={!r.isOpen} /> : <span className="text-ink-subtle">Not set</span>}
                  </Meta>
                  <Meta label="Resolved">
                    {r.resolvedAt ? (
                      <span className="flex flex-col">
                        <span className="numeric">{formatDateTime(r.resolvedAt, timeZone)}</span>
                        {r.resolvedBy ? <span className="text-xs text-ink-muted">by {r.resolvedBy.name}</span> : null}
                      </span>
                    ) : (
                      <span className="text-ink-subtle">Not yet</span>
                    )}
                  </Meta>
                  <Meta label="Turnaround">
                    <span className="numeric">{r.cycleSeconds !== null ? formatSeconds(r.cycleSeconds) : "—"}</span>
                  </Meta>
                </dl>

                {r.resolutionNote ? (
                  <p className="rounded-md bg-surface-sunken px-3 py-2 text-sm text-ink-secondary">
                    <span className="font-medium text-ink">Resolution note:</span> {r.resolutionNote}
                  </p>
                ) : null}

                {linked.length > 0 ? (
                  <div className="border-t border-border pt-4">
                    <p className="eyebrow mb-2 flex items-center gap-1.5">
                      <MessageSquare aria-hidden="true" className="size-3" />
                      Conversation ({linked.length})
                    </p>
                    <ul className="flex flex-col gap-2">
                      {linked.map((c) => (
                        <li key={c.id}>
                          <Link
                            href={`/jobs/${jobId}?tab=comments#comment-${c.id}`}
                            className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-muted focus-ring sm:flex-row sm:items-baseline sm:gap-3"
                          >
                            <span className="shrink-0 text-xs font-medium text-ink">{c.author.name}</span>
                            <span className="min-w-0 flex-1 truncate text-sm text-ink-secondary">{c.body === null ? <em className="text-ink-subtle">deleted</em> : clip(c.body, 140)}</span>
                            <span className="shrink-0 text-2xs text-ink-subtle numeric">{formatDateTime(c.createdAt, timeZone)}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {r.isOpen ? (
                  <div className="border-t border-status-revision/15 pt-4">
                    <RevisionActions jobId={jobId} jobVersion={jobVersion} revision={r} canEdit={canEditOpen} canWithdraw={canWithdraw} canRespond={canRespond} timeZone={timeZone} />
                  </div>
                ) : null}
              </div>
            </Card>
          </li>
        );
      })}
    </ol>
  );
}
