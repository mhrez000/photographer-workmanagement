import Link from "next/link";
import { MessageSquareQuote } from "lucide-react";
import { RoundBadge, RushBadge } from "@/components/jobs/stage-pill";
import { Card } from "@/components/ui/card";
import { formatDateShort, formatRelative } from "@/lib/dates";
import type { MyJobCard } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CardActions } from "./card-actions";
import { DUE_TONE_CLASS, dueText } from "./due-text";

export type MyJobCardKind = "changes_asked" | "late" | "to_do" | "waiting" | "done";

export interface MyJobCardViewProps {
  card: MyJobCard;
  kind: MyJobCardKind;
  timeZone: string;
}

/**
 * One job on My jobs (docs/SIMPLIFICATION-PLAN.md §6): address · client · "Due tomorrow" / "1 day late"
 * · "Shot by Mo" · [Raw files] · one main button. Changes-asked cards quote the request; To do cards say
 * New or Editing; Waiting / Done cards are read only.
 */
export function MyJobCardView({ card, kind, timeZone }: MyJobCardViewProps) {
  const { job, changesAsked, toDoLabel } = card;
  const due = dueText(job.due, timeZone);
  const href = `/jobs/${encodeURIComponent(job.id)}`;
  const readOnly = kind === "waiting" || kind === "done";

  return (
    <li className="min-w-0">
      <Card tone={kind === "changes_asked" ? "danger" : "default"} className={cn("h-full gap-3 p-4", readOnly && "bg-surface-sunken/60")}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Link href={href} className="block truncate text-base font-semibold leading-6 text-ink hover:underline underline-offset-4 focus-ring rounded-xs">
              {job.name}
            </Link>
            <p className="mt-0.5 truncate text-sm text-ink-muted">{job.client.name}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            <RoundBadge round={job.round} />
            <RushBadge rush={job.rush} />
          </div>
        </div>

        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          {kind === "done" ? (
            <span className="text-success-fg">Done {formatDateShort(job.statusEnteredAt, timeZone)}</span>
          ) : kind === "waiting" ? (
            <span className="text-ink-secondary">{job.sentAt ? `Sent ${formatRelative(job.sentAt)}` : "Sent for checking"}</span>
          ) : (
            <span className={DUE_TONE_CLASS[due.tone]}>{due.label}</span>
          )}
          {toDoLabel ? (
            <>
              <span aria-hidden="true" className="text-ink-subtle">
                ·
              </span>
              <span className={cn("rounded-sm px-1.5 text-xs font-medium", toDoLabel === "editing" ? "bg-stage-blue-soft text-stage-blue-fg" : "bg-surface-muted text-ink-secondary")}>{toDoLabel === "editing" ? "Editing" : "New"}</span>
            </>
          ) : null}
          {job.photographer ? (
            <>
              <span aria-hidden="true" className="text-ink-subtle">
                ·
              </span>
              <span className="text-ink-muted">Shot by {job.photographer.name}</span>
            </>
          ) : null}
        </p>

        {changesAsked ? (
          <blockquote className="flex gap-2 rounded-md border border-danger/20 bg-surface px-3 py-2 text-sm">
            <MessageSquareQuote aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="min-w-0">
              <p className="whitespace-pre-line break-words text-ink">{changesAsked.text || changesAsked.reason}</p>
              <footer className="mt-1 text-xs text-ink-muted">
                Round {changesAsked.round} · {changesAsked.who.name} · {formatRelative(changesAsked.when)}
              </footer>
            </div>
          </blockquote>
        ) : null}

        {!readOnly ? <CardActions card={card} timeZone={timeZone} /> : null}
      </Card>
    </li>
  );
}
