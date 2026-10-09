"use client";

import * as React from "react";
import Link from "next/link";
import { DueChip } from "@/components/jobs/due-chip";
import { jobHref } from "@/components/jobs/job-link";
import { PausedChip } from "@/components/jobs/paused-chip";
import { PersonChip } from "@/components/jobs/person";
import { PriorityPill } from "@/components/jobs/priority-pill";
import { RevisionCount } from "@/components/jobs/revision-count";
import { StatusPill } from "@/components/jobs/status-pill";
import { STATUS_CATEGORY_META } from "@/lib/constants";
import type { KanbanCard as KanbanCardData } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface KanbanCardViewProps {
  card: KanbanCardData;
  timeZone: string;
  /** Rendered inside the DragOverlay (lifted look, no link focus). */
  overlay?: boolean;
  /** The card's slot while its overlay is being dragged. */
  ghost?: boolean;
  /** Optimistically moved; waiting for the server. */
  pending?: boolean;
  /** Show the precise status pill (columns that hold several statuses). */
  showStatus?: boolean;
}

/**
 * Presentational kanban card: number + priority, job name, client, then a
 * footer with editor avatar, due chip, revision count and paused chip.
 * Overdue jobs get a danger hairline on the left edge, due today attention.
 */
export function KanbanCardView({ card, timeZone, overlay = false, ghost = false, pending = false, showStatus = false }: KanbanCardViewProps) {
  const done = STATUS_CATEGORY_META[card.statusCategory]?.done ?? false;
  const completedAt = card.statusCategory === "completed" ? card.statusEnteredAt : null;
  const edge = card.isOverdue ? "before:bg-danger" : card.isDueToday ? "before:bg-attention" : "before:bg-transparent";

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
        <span className="numeric text-2xs font-semibold tracking-wide text-ink-muted">{card.jobNumber}</span>
        <div className="flex items-center gap-1">
          {card.isPaused ? <PausedChip compact /> : null}
          <RevisionCount count={card.revisionCount} />
          <PriorityPill priority={card.priority} quietNormal compact />
        </div>
      </div>

      <p className="mt-1.5 line-clamp-2 text-sm font-medium leading-snug text-ink">
        {overlay ? (
          card.name
        ) : (
          <Link
            href={jobHref(card.id)}
            tabIndex={-1}
            draggable={false}
            className="after:absolute after:inset-0 after:content-[''] hover:underline hover:decoration-border-strong hover:underline-offset-2"
            onClick={(e) => e.stopPropagation()}
          >
            {card.name}
          </Link>
        )}
      </p>
      <p className="mt-0.5 truncate text-xs text-ink-muted">{card.client.name}</p>

      {showStatus ? (
        <div className="mt-2">
          <StatusPill status={card.status} size="xs" />
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-between gap-2">
        <PersonChip user={card.editor} size="xs" avatarOnly emptyLabel="No editor" />
        <DueChip due={card.dueDate} timeZone={timeZone} done={done} completedAt={completedAt} compact />
      </div>
    </div>
  );
}
