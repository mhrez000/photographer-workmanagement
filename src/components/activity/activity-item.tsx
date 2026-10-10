"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowRight,
  Bot,
  CalendarClock,
  ChevronDown,
  CircleDot,
  Clock,
  FolderOpen,
  Link2,
  MessageSquare,
  NotebookPen,
  PencilLine,
  Plus,
  RotateCcw,
  Settings2,
  UserRoundCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { StatusPill } from "@/components/jobs/status-pill";
import { formatDateTime, formatTime } from "@/lib/dates";
import type { ActivityFeedItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { buildDiff, type DiffRow, type DiffValue } from "./activity-diff";
import { groupOfEventType } from "./event-groups";

const GROUP_ICONS: Record<string, LucideIcon> = {
  status: CircleDot,
  created: Plus,
  assignments: UserRoundCheck,
  deadlines: CalendarClock,
  edits: PencilLine,
  revisions: RotateCcw,
  comments: MessageSquare,
  notes: NotebookPen,
  links: Link2,
  time: Clock,
  structure: FolderOpen,
  people: Users,
  admin: Settings2,
};

function GroupGlyph({ groupKey }: { groupKey: string | undefined }) {
  return React.createElement((groupKey && GROUP_ICONS[groupKey]) || CircleDot, { className: "size-2.5" });
}

export interface ActivityItemProps {
  item: ActivityFeedItem;
  timeZone: string;
  people: Readonly<Record<string, string>>;
  /** Hide the job link inside the sentence (e.g. on a job's own page). */
  hideJob?: boolean;
}

/** Splits the feed sentence into actor / text / job-link segments. */
function Sentence({ item, hideJob }: { item: ActivityFeedItem; hideJob?: boolean }) {
  const who = item.actor?.name ?? (item.isSystem ? (item.metadata.cause === "automation" ? "Automation" : "System") : "Someone");
  const sentence = item.sentence ?? `${who} ${item.summary}`;
  const jobLabel = item.job ? `“${item.job.jobNumber} ${item.job.name}”` : null;

  let head = sentence;
  let tail = "";
  let hasJob = false;
  if (jobLabel) {
    const at = sentence.indexOf(jobLabel);
    if (at >= 0) {
      head = sentence.slice(0, at);
      tail = sentence.slice(at + jobLabel.length);
      hasJob = true;
    }
  }

  let actorPart: string | null = null;
  for (const candidate of [item.actor?.name, "Automation", "System"]) {
    if (candidate && head.startsWith(candidate)) {
      actorPart = candidate;
      head = head.slice(candidate.length);
      break;
    }
  }

  return (
    <p className="min-w-0 text-sm leading-6 text-ink-secondary">
      {actorPart ? <span className="font-medium text-ink">{actorPart}</span> : null}
      {head}
      {hasJob && item.job ? (
        hideJob ? (
          <span className="text-ink">this job</span>
        ) : (
          <Link
            href={`/jobs/${item.job.id}`}
            className="rounded-xs font-medium text-ink underline decoration-border-strong underline-offset-2 hover:decoration-ink focus-ring"
            title={`${item.job.jobNumber} · ${item.job.name}`}
          >
            <span className="font-mono text-xs text-ink-muted numeric">{item.job.jobNumber}</span> {item.job.name}
          </Link>
        )
      ) : null}
      {tail}
    </p>
  );
}

function Value({ value, struck }: { value: DiffValue; struck?: boolean }) {
  const strike = struck ? "line-through decoration-ink-subtle/70 text-ink-muted" : "text-ink";
  switch (value.kind) {
    case "status":
      return (
        <span className={cn("inline-flex", struck && "opacity-60")}>
          <StatusPill status={{ name: value.name, category: value.category }} size="sm" className={cn(struck && "line-through")} />
        </span>
      );
    case "person":
      return (
        <span className={cn("inline-flex items-center gap-1.5", strike)}>
          <Avatar name={value.name} size="xs" />
          {value.name}
        </span>
      );
    case "url":
      return struck ? (
        <span className={cn("break-all", strike)}>{value.label}</span>
      ) : (
        <a href={value.url} target="_blank" rel="noopener noreferrer" className="break-all text-accent-ink underline-offset-2 hover:underline focus-ring rounded-xs">
          {value.label}
        </a>
      );
    case "long":
      return <span className={cn("whitespace-pre-line break-words", strike)}>{value.text}</span>;
    default:
      return <span className={cn("break-words", strike)}>{value.text}</span>;
  }
}

function DiffTable({ rows }: { rows: DiffRow[] }) {
  return (
    <dl className="grid gap-2.5 rounded-md border border-border bg-surface-sunken/60 px-3 py-2.5 text-sm">
      {rows.map((row) => (
        <div key={row.key} className="grid gap-1 sm:grid-cols-[120px_1fr] sm:gap-3">
          <dt className="eyebrow pt-0.5">{row.label}</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {row.before ? <Value value={row.before} struck={Boolean(row.after)} /> : null}
            {row.before && row.after ? <ArrowRight aria-label="changed to" className="size-3.5 shrink-0 text-ink-subtle" /> : null}
            {row.after ? <Value value={row.after} /> : null}
            {row.before && !row.after ? <span className="text-xs text-ink-subtle">(removed)</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** One feed line: avatar, sentence, exact time on hover, expandable before → after. */
export function ActivityItem({ item, timeZone, people, hideJob }: ActivityItemProps) {
  const [open, setOpen] = React.useState(false);
  const rows = React.useMemo(() => buildDiff(item, { timeZone, people }), [item, timeZone, people]);
  const group = groupOfEventType(item.eventType);
  const automated = item.metadata.cause === "automation";
  const detailsId = `activity-${item.id}-details`;
  const exact = formatDateTime(item.createdAt, timeZone);

  return (
    <li className="group/item relative flex gap-3 py-3">
      <div className="relative shrink-0">
        {item.actor ? (
          <Avatar name={item.actor.name} colour={item.actor.isActive ? item.actor.avatarColour : undefined} size="md" />
        ) : (
          <span className="flex size-8 items-center justify-center rounded-full bg-surface-muted text-ink-muted ring-1 ring-inset ring-border">
            <Bot aria-hidden="true" className="size-4" />
          </span>
        )}
        <span
          aria-hidden="true"
          className="absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full bg-surface text-ink-muted ring-1 ring-border"
          title={group?.label}
        >
          <GroupGlyph groupKey={group?.key} />
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <Sentence item={item} hideJob={hideJob} />
          <div className="flex shrink-0 items-center gap-2">
            {item.visibility === "management" ? (
              <Badge size="sm" variant="outline" title="Visible to the owner and admins only">
                Management
              </Badge>
            ) : null}
            {automated ? (
              <Badge size="sm" variant="info">
                Automation
              </Badge>
            ) : null}
            <time dateTime={item.createdAt} title={exact} className="numeric text-xs text-ink-muted">
              {formatTime(item.createdAt, timeZone)}
            </time>
          </div>
        </div>
        {rows.length > 0 ? (
          <div className="mt-1">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls={detailsId}
              className="inline-flex items-center gap-1 rounded-xs text-xs font-medium text-ink-muted hover:text-ink focus-ring"
            >
              <ChevronDown aria-hidden="true" className={cn("size-3.5 transition-transform duration-(--motion-fast)", open && "rotate-180")} />
              {open ? "Hide details" : "Before → after"}
            </button>
            {open ? (
              <div id={detailsId} className="mt-2 animate-fade-in">
                <DiffTable rows={rows} />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
