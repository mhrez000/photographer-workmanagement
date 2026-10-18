"use client";

import * as React from "react";
import Link from "next/link";
import { Images } from "lucide-react";
import { RoundBadge, RushBadge, StagePill, WaitingOn, stageSubLabelText } from "@/components/jobs/stage-pill";
import { SimpleDueChip } from "@/components/jobs-list/simple-due-chip";
import type { StageBoardCard } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface KanbanCardViewProps {
  card: StageBoardCard;
  timeZone: string;
  /** The viewer's id ("Waiting on: You"). */
  viewerId: string | null;
  /** Rendered inside the DragOverlay (lifted look, no link focus). */
  overlay?: boolean;
  /** The card's slot while its overlay is being dragged. */
  ghost?: boolean;
  /** Saving a drop; waiting for the server. */
  pending?: boolean;
}

/**
 * One job on the Board — the same pieces as a row on the Jobs list (docs/SIMPLIFICATION-PLAN.md §4):
 * number, address, client · type of shoot, the stage pill with Round / Rush beside it and the
 * secondary text underneath ("Not started", "Editing since 9 Oct", "Not sent to client"), then
 * "Waiting on: Sam" and the due chip. Late jobs get a red hairline on the left, due today amber.
 */
export function KanbanCardView({ card, timeZone, viewerId, overlay = false, ghost = false, pending = false }: KanbanCardViewProps) {
  const { job } = card;
  const dueToday = job.stage.active && job.due.daysFromToday === 0;
  const edge = job.due.late ? "before:bg-danger" : dueToday ? "before:bg-attention" : "before:bg-transparent";
  const sub = job.stage.subLabel === "round" ? null : stageSubLabelText(job.stage, job.startedAt, timeZone);

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border border-border bg-surface p-3 text-left shadow-xs",
        "before:absolute before:inset-y-0 before:left-0 before:w-[3px]",
        edge,
        "transition-[box-shadow,border-color,opacity,transform] duration-(--motion-fast) ease-out-soft",
        !overlay && !ghost && "group-hover/card:border-border-hover group-hover/card:shadow-sm",
        overlay && "rotate-[1.5deg] cursor-grabbing border-border-strong shadow-pop",
        ghost && "border-dashed opacity-40 shadow-none",
        pending && "opacity-70",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="numeric text-2xs font-semibold tracking-wide text-ink-muted">{job.jobNumber}</span>
        <div className="flex items-center gap-1">
          <RushBadge rush={job.rush} />
          <RoundBadge round={job.round} />
          {pending ? <span className="text-2xs text-ink-subtle">Saving…</span> : null}
        </div>
      </div>

      <p className="mt-1.5 line-clamp-2 text-sm font-medium leading-snug text-ink">
        {overlay ? (
          job.name
        ) : (
          <Link
            href={`/jobs/${encodeURIComponent(job.id)}`}
            tabIndex={-1}
            draggable={false}
            className="after:absolute after:inset-0 after:content-[''] hover:underline hover:decoration-border-strong hover:underline-offset-2"
            onClick={(e) => e.stopPropagation()}
          >
            {job.name}
          </Link>
        )}
      </p>
      <p className="mt-0.5 truncate text-xs text-ink-muted" title={`${job.client.name} · ${job.jobTypeName}`}>
        {job.client.name} <span aria-hidden="true">·</span> {job.jobTypeName}
      </p>

      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
        <StagePill display={job.stage} hideSubLabel className="shrink-0" />
        {sub ? <span className="truncate text-xs text-ink-muted">{sub}</span> : null}
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <WaitingOn
          job={{ category: job.statusCategory, photographer: job.photographer, editor: job.editor }}
          viewerId={viewerId}
          className="min-w-0 truncate text-xs"
        />
        <div className="flex shrink-0 items-center gap-1.5">
          {job.finishedLink ? (
            overlay ? (
              <Images aria-hidden="true" className="size-3.5 text-ink-muted" />
            ) : (
              <a
                href={job.finishedLink.url}
                target="_blank"
                rel="noopener noreferrer"
                draggable={false}
                onClick={(e) => e.stopPropagation()}
                aria-label="Open finished photos"
                title="Open finished photos"
                className="relative z-10 inline-flex size-6 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-muted hover:text-ink focus-ring"
              >
                <Images aria-hidden="true" className="size-3.5" />
              </a>
            )
          ) : null}
          <SimpleDueChip due={job.due} active={job.stage.active} />
        </div>
      </div>
    </div>
  );
}
