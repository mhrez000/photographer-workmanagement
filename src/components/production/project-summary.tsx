import * as React from "react";
import { CalendarCheck2, CalendarClock, CalendarDays, Camera, CircleCheck, Flag } from "lucide-react";
import { KANBAN_COLUMNS, KANBAN_COLUMN_META, STATUS_CATEGORY_META, type KanbanColumn } from "@/lib/constants";
import { formatDate } from "@/lib/dates";
import type { JobRow } from "@/lib/types";
import { cn } from "@/lib/utils";

const COLUMN_HEX: Record<KanbanColumn, string> = Object.fromEntries(
  KANBAN_COLUMNS.map((c) => [c, STATUS_CATEGORY_META[KANBAN_COLUMN_META[c].categories[0]].hex]),
) as Record<KanbanColumn, string>;

/** Jobs by workflow stage as one stacked bar + legend (cancelled shown separately). */
export function StageBreakdown({ jobs }: { jobs: JobRow[] }) {
  const counts = new Map<KanbanColumn, number>();
  let cancelled = 0;
  for (const j of jobs) {
    const col = STATUS_CATEGORY_META[j.statusCategory].kanbanColumn;
    if (col) counts.set(col, (counts.get(col) ?? 0) + 1);
    else cancelled += 1;
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0 && cancelled === 0) return <p className="text-sm text-ink-muted">No jobs yet.</p>;
  const present = KANBAN_COLUMNS.filter((c) => (counts.get(c) ?? 0) > 0);

  return (
    <div className="flex flex-col gap-3">
      {total > 0 ? (
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-muted" role="img" aria-label={present.map((c) => `${counts.get(c)} ${KANBAN_COLUMN_META[c].label}`).join(", ")}>
          {present.map((c) => (
            <span key={c} className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${((counts.get(c) ?? 0) / total) * 100}%`, backgroundColor: COLUMN_HEX[c] }} />
          ))}
        </div>
      ) : null}
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        {present.map((c) => (
          <li key={c} className="flex items-center gap-2">
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: COLUMN_HEX[c] }} />
            <span className="truncate text-ink-secondary">{KANBAN_COLUMN_META[c].label}</span>
            <span className="ml-auto font-medium text-ink numeric">{counts.get(c)}</span>
          </li>
        ))}
        {cancelled > 0 ? (
          <li className="flex items-center gap-2">
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: STATUS_CATEGORY_META.cancelled.hex }} />
            <span className="truncate text-ink-muted">Cancelled</span>
            <span className="ml-auto text-ink-muted numeric">{cancelled}</span>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

interface Milestone {
  key: string;
  label: string;
  at: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  detail?: string;
}

function minBy<T>(items: T[], f: (x: T) => string | null): T | null {
  let best: T | null = null;
  let bestV: string | null = null;
  for (const it of items) {
    const v = f(it);
    if (v && (bestV === null || v < bestV)) {
      best = it;
      bestV = v;
    }
  }
  return best;
}

function maxBy<T>(items: T[], f: (x: T) => string | null): T | null {
  let best: T | null = null;
  let bestV: string | null = null;
  for (const it of items) {
    const v = f(it);
    if (v && (bestV === null || v > bestV)) {
      best = it;
      bestV = v;
    }
  }
  return best;
}

/**
 * Key dates for a project, oldest first: project start, first shoot, next
 * deadline, final deadline, project end. Past milestones are dimmed and
 * ticked; the next upcoming one is highlighted.
 */
export function ProjectTimeline({
  project,
  jobs,
  timeZone,
  now,
}: {
  project: { createdAt: string; startDate: string | null; endDate: string | null };
  jobs: JobRow[];
  timeZone: string;
  now: string;
}) {
  const live = jobs.filter((j) => j.statusCategory !== "cancelled");
  const open = live.filter((j) => STATUS_CATEGORY_META[j.statusCategory].open && !STATUS_CATEGORY_META[j.statusCategory].done);
  const firstShoot = minBy(live, (j) => j.shootDate);
  const lastShoot = maxBy(live, (j) => j.shootDate);
  const nextDue = minBy(
    open.filter((j) => j.dueDate && j.dueDate >= now),
    (j) => j.dueDate,
  );
  const finalDue = maxBy(open, (j) => j.dueDate);

  const items: Milestone[] = [];
  items.push({ key: "start", label: project.startDate ? "Project start" : "Project created", at: project.startDate ?? project.createdAt, icon: Flag });
  if (firstShoot?.shootDate) items.push({ key: "shoot", label: "First shoot", at: firstShoot.shootDate, icon: Camera, detail: firstShoot.name });
  if (lastShoot?.shootDate && lastShoot.id !== firstShoot?.id) items.push({ key: "lastshoot", label: "Last shoot", at: lastShoot.shootDate, icon: Camera, detail: lastShoot.name });
  if (nextDue?.dueDate) items.push({ key: "next", label: "Next deadline", at: nextDue.dueDate, icon: CalendarClock, detail: nextDue.name });
  if (finalDue?.dueDate && finalDue.id !== nextDue?.id) items.push({ key: "final", label: "Final deadline", at: finalDue.dueDate, icon: CalendarCheck2, detail: finalDue.name });
  if (project.endDate) items.push({ key: "end", label: "Project end", at: project.endDate, icon: CalendarDays });
  items.sort((a, b) => a.at.localeCompare(b.at));
  const upcomingIndex = items.findIndex((m) => m.at >= now);
  const overdue = open.filter((j) => j.isOverdue).length;

  return (
    <div className="flex flex-col gap-3">
      <ol className="relative flex flex-col gap-3 before:absolute before:bottom-2 before:left-[11px] before:top-2 before:w-px before:bg-border">
        {items.map((m, i) => {
          const past = m.at < now;
          const next = i === upcomingIndex;
          const Icon = past ? CircleCheck : m.icon;
          return (
            <li key={m.key} className="relative flex items-start gap-3">
              <span
                className={cn(
                  "relative z-[1] flex size-6 shrink-0 items-center justify-center rounded-full ring-4 ring-surface",
                  past ? "bg-surface-muted text-ink-subtle" : next ? "bg-accent text-accent-fg" : "bg-surface-muted text-ink-muted",
                )}
              >
                <Icon aria-hidden="true" className="size-3.5" />
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className={cn("text-sm", past ? "text-ink-muted" : "font-medium text-ink")}>{m.label}</span>
                  <span className={cn("shrink-0 text-xs numeric", next ? "font-medium text-accent-ink" : "text-ink-muted")}>{formatDate(m.at, timeZone)}</span>
                </div>
                {m.detail ? <div className="truncate text-xs text-ink-muted">{m.detail}</div> : null}
              </div>
            </li>
          );
        })}
      </ol>
      {overdue > 0 ? (
        <p className="rounded-md bg-danger-soft/60 px-3 py-2 text-xs text-danger-fg">
          {overdue} job{overdue === 1 ? " is" : "s are"} past due.
        </p>
      ) : null}
    </div>
  );
}
