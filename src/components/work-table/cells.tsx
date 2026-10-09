/**
 * Cell renderers shared by every work table (All Work, Jobs, Team Work) and
 * the mobile job card. Server-safe (no hooks), so they render in client
 * islands and server components alike.
 */
import * as React from "react";
import { ExternalLink } from "lucide-react";
import { DueChip } from "@/components/jobs/due-chip";
import { LinkProviderIcon } from "@/components/jobs/link-provider";
import { PausedChip } from "@/components/jobs/paused-chip";
import { PersonChip } from "@/components/jobs/person";
import { PriorityPill } from "@/components/jobs/priority-pill";
import { RelativeTime } from "@/components/jobs/relative-time";
import { RevisionCount } from "@/components/jobs/revision-count";
import { StatusPill } from "@/components/jobs/status-pill";
import { CATEGORY_GROUPS, type JobTableColumn } from "@/lib/constants";
import { formatDateShort, formatDateTime } from "@/lib/dates";
import type { JobRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { isAllowedLinkUrl } from "@/lib/validation/links";

/** Deadline already met or not applicable (done / cancelled): never draw urgency. */
export function deadlineSettled(row: Pick<JobRow, "statusCategory">): boolean {
  return !CATEGORY_GROUPS.DEADLINE_BOUND.includes(row.statusCategory);
}

const LINK_KIND_LABELS: Record<string, string> = {
  raw_files: "Raw files",
  editing_workspace: "Editing workspace",
  finished_files: "Finished files",
  gallery: "Gallery",
  client_delivery: "Client delivery",
  reference: "Reference",
  other: "Link",
};

/** "3d left" / "Today" / "2d late" coloured by urgency; muted once the deadline no longer applies. */
export function DaysRemaining({ row, className }: { row: Pick<JobRow, "daysRemaining" | "statusCategory" | "isOverdue" | "isDueToday">; className?: string }) {
  const d = row.daysRemaining;
  if (d === null) return <span className={cn("text-ink-subtle", className)}>—</span>;
  if (deadlineSettled(row)) {
    return <span className={cn("numeric text-ink-subtle", className)}>{d < 0 ? `${-d}d ago` : `${d}d`}</span>;
  }
  const tone = row.isOverdue || d < 0 ? "text-danger-fg" : row.isDueToday || d === 0 ? "text-attention-fg" : d <= 2 ? "text-warning-fg" : "text-ink-secondary";
  const label = d < 0 ? `${-d}d late` : d === 0 ? "Today" : `${d}d`;
  return (
    <span className={cn("numeric font-medium", tone, className)} title={d < 0 ? `${-d} days overdue` : d === 0 ? "Due today" : `${d} days remaining`}>
      {label}
    </span>
  );
}

/** Mini completion bar + value. */
export function CompletionBar({ value, className }: { value: number; className?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const tone = pct >= 100 ? "bg-success" : pct >= 67 ? "bg-accent" : pct >= 34 ? "bg-info" : "bg-ink-subtle";
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <span
        role="progressbar"
        aria-label="Completion"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="relative h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-surface-muted"
      >
        <span className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-(--motion-base)", tone)} style={{ width: `${pct}%` }} />
      </span>
      <span className="numeric w-9 text-right text-xs text-ink-muted">{pct}%</span>
    </span>
  );
}

/** Icon-only external link for the job's most relevant current link. */
export function PrimaryLinkButton({ link, jobLabel }: { link: JobRow["primaryLink"]; jobLabel: string }) {
  if (!link) return <span className="text-ink-subtle" aria-label="No link">—</span>;
  const kind = LINK_KIND_LABELS[link.kind] ?? "Link";
  const name = `${link.label?.trim() || kind} for ${jobLabel} (opens in a new tab)`;
  if (!isAllowedLinkUrl(link.url)) {
    return (
      <span className="inline-flex size-7 items-center justify-center text-ink-subtle" title={`${kind}: unsupported link`}>
        <LinkProviderIcon url={null} className="size-4" />
      </span>
    );
  }
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${kind} · ${link.url}`}
      aria-label={name}
      className="group/ext inline-flex size-7 items-center justify-center rounded-sm text-ink-muted transition-colors duration-(--motion-fast) hover:bg-surface-muted hover:text-ink focus-ring"
    >
      <LinkProviderIcon url={link.url} className="size-4 group-hover/ext:hidden" />
      <ExternalLink aria-hidden="true" className="hidden size-3.5 group-hover/ext:block" />
    </a>
  );
}

function DateText({ value, timeZone }: { value: string | null; timeZone: string }) {
  if (!value) return <span className="text-ink-subtle">—</span>;
  return (
    <span className="numeric whitespace-nowrap text-ink-secondary" title={formatDateTime(value, timeZone)}>
      {formatDateShort(value, timeZone)}
    </span>
  );
}

/** One cell's content for `column` (the "job" column is drawn by the table itself). */
export function WorkCell({ column, row, timeZone }: { column: JobTableColumn; row: JobRow; timeZone: string }): React.ReactNode {
  const settled = deadlineSettled(row);
  switch (column) {
    case "job":
      return <JobIdentity row={row} timeZone={timeZone} />;
    case "client":
      return (
        <span className="block truncate text-ink-secondary" title={row.client.name}>
          {row.client.name}
        </span>
      );
    case "project":
      return (
        <span className="block truncate text-ink-secondary" title={row.project.name}>
          {row.project.name}
        </span>
      );
    case "photographer":
      return <PersonChip user={row.photographer} size="xs" emptyLabel="None" className="max-w-full" />;
    case "editor":
      return <PersonChip user={row.editor} size="xs" emptyLabel="Unassigned" className="max-w-full" />;
    case "status":
      return <StatusPill status={row.status} size="sm" />;
    case "priority":
      return <PriorityPill priority={row.priority} size="sm" />;
    case "created":
      return <DateText value={row.createdAt} timeZone={timeZone} />;
    case "shootDate":
      return <DateText value={row.shootDate} timeZone={timeZone} />;
    case "dueDate":
      return <DueChip due={row.dueDate} timeZone={timeZone} done={settled} compact />;
    case "daysRemaining":
      return <DaysRemaining row={row} />;
    case "revisionCount":
      return row.revisionCount > 0 ? <RevisionCount count={row.revisionCount} /> : <span className="numeric text-ink-subtle">0</span>;
    case "lastActivity":
      return <RelativeTime value={row.lastActivityAt} timeZone={timeZone} className="text-ink-muted" />;
    case "completionPercent":
      return <CompletionBar value={row.completionPercent} />;
    case "link":
      return <PrimaryLinkButton link={row.primaryLink} jobLabel={`${row.jobNumber} ${row.name}`} />;
    case "jobType":
      return (
        <span className="flex min-w-0 items-center gap-2 text-ink-secondary">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: row.jobType.colour }} />
          <span className="truncate">{row.jobType.name}</span>
        </span>
      );
    case "reviewDueDate":
      return <DueChip due={row.reviewDueDate} timeZone={timeZone} done={settled} compact kind="Review due" />;
    case "deliveryDueDate":
      return <DueChip due={row.deliveryDueDate} timeZone={timeZone} done={row.statusCategory === "completed" || row.statusCategory === "cancelled"} compact kind="Delivery due" />;
  }
}

/** Number + name (+ paused chip and project) — the identifying content of a row. */
export function JobIdentity({ row, timeZone, showProject = true }: { row: JobRow; timeZone: string; showProject?: boolean }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-mono text-xs text-ink-muted numeric">{row.jobNumber}</span>
        <span className="truncate font-medium text-ink" title={row.name}>
          {row.name}
        </span>
        {row.isPaused ? <PausedChip compact timeZone={timeZone} className="shrink-0 self-center" /> : null}
      </span>
      {showProject && row.project.name !== row.name ? (
        <span className="truncate text-xs text-ink-subtle" title={row.project.name}>
          {row.project.name}
        </span>
      ) : null}
    </span>
  );
}
