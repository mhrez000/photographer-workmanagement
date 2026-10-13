import Link from "next/link";
import { Camera, ChevronLeft, ChevronRight, Flag } from "lucide-react";
import { civilDays, normaliseWeekStart, parseCivil, sameMonth, weekdayLabels, type WeekStart } from "@/components/calendar/calendar-utils";
import { EmptyState } from "@/components/ui/empty-state";
import { STAGE_TONE_CLASSES } from "@/lib/constants";
import { STAGE_META } from "@/lib/stages";
import type { SimpleCalendarEvent, SimpleCalendarKind } from "@/lib/types";
import { cn } from "@/lib/utils";
import { civilLong, monthStart, monthTitle, shiftMonth } from "./format";

export interface MonthCalendarProps {
  events: SimpleCalendarEvent[];
  /** "YYYY-MM" being shown. */
  month: string;
  today: string;
  weekStartsOn: number;
  /** Builds the href that shows another month (keeps the page's other filters). */
  hrefForMonth: (month: string) => string;
  /** Kinds drawn (default both). */
  kinds?: readonly SimpleCalendarKind[];
  className?: string;
}

/** The civil range a month grid covers (full weeks around the month). */
export function monthGridRange(month: string, weekStartsOn: number): { from: string; to: string } {
  const ws = normaliseWeekStart(weekStartsOn);
  const first = parseCivil(monthStart(month));
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const lead = (first.getDay() - ws + 7) % 7;
  const trail = (ws + 6 - last.getDay() + 7) % 7;
  const from = new Date(first);
  from.setDate(first.getDate() - lead);
  const to = new Date(last);
  to.setDate(last.getDate() + trail);
  const civil = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { from: civil(from), to: civil(to) };
}

const KIND_META: Record<SimpleCalendarKind, { label: string; icon: typeof Camera }> = {
  shoot: { label: "Shoot", icon: Camera },
  due: { label: "Due", icon: Flag },
};

function EventChip({ event, compact }: { event: SimpleCalendarEvent; compact: boolean }) {
  const meta = KIND_META[event.kind];
  const Icon = meta.icon;
  const late = event.kind === "due" && event.job.due.late;
  const tone = event.kind === "due" ? STAGE_TONE_CLASSES[STAGE_META[event.job.stage.stage].tone].pill : "bg-surface-muted text-ink-secondary";
  const title = `${meta.label}: ${event.job.name} · ${event.job.client.name}${late ? " (late)" : ""}`;
  return (
    <Link
      href={`/jobs/${event.job.id}`}
      title={title}
      className={cn(
        "flex min-w-0 items-center gap-1 rounded-sm px-1.5 text-left leading-none focus-ring transition-[filter] hover:brightness-95",
        compact ? "h-6 text-2xs" : "h-8 text-sm",
        late ? "bg-danger-soft font-semibold text-danger-fg ring-1 ring-inset ring-danger/40" : tone,
      )}
    >
      <Icon aria-hidden="true" className={cn("shrink-0", compact ? "size-3" : "size-3.5")} />
      <span className="truncate">{event.job.name}</span>
      {!compact ? <span className="ml-auto shrink-0 truncate pl-2 text-xs font-normal opacity-80">{event.job.client.name}</span> : null}
    </Link>
  );
}

const VISIBLE = 3;

/**
 * Month grid of shoot and due dates for the List / Calendar switch and the editor's Calendar page
 * (docs/SIMPLIFICATION-PLAN.md §3, §11). Server-rendered: month navigation is links, each event
 * links to its job, late due dates are red. Phones get a day-by-day list of the same month.
 */
export function MonthCalendar({ events, month, today, weekStartsOn, hrefForMonth, kinds = ["shoot", "due"], className }: MonthCalendarProps) {
  const ws: WeekStart = normaliseWeekStart(weekStartsOn);
  const range = monthGridRange(month, ws);
  const days = civilDays(range.from, range.to);
  const labels = weekdayLabels(ws);
  const shown = events.filter((e) => kinds.includes(e.kind));
  const byDay = new Map<string, SimpleCalendarEvent[]>();
  for (const e of shown) byDay.set(e.civilDate, [...(byDay.get(e.civilDate) ?? []), e]);
  const inMonth = shown.filter((e) => sameMonth(e.civilDate, monthStart(month)));
  const lateCount = inMonth.filter((e) => e.kind === "due" && e.job.due.late).length;
  const thisMonth = today.slice(0, 7);

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link href={hrefForMonth(shiftMonth(month, -1))} aria-label="Previous month" className="inline-flex size-8 items-center justify-center rounded-sm border border-border bg-surface text-ink-secondary shadow-xs hover:bg-surface-muted focus-ring">
            <ChevronLeft aria-hidden="true" className="size-4" />
          </Link>
          <Link href={hrefForMonth(shiftMonth(month, 1))} aria-label="Next month" className="inline-flex size-8 items-center justify-center rounded-sm border border-border bg-surface text-ink-secondary shadow-xs hover:bg-surface-muted focus-ring">
            <ChevronRight aria-hidden="true" className="size-4" />
          </Link>
          {month !== thisMonth ? (
            <Link href={hrefForMonth(thisMonth)} className="inline-flex h-8 items-center rounded-sm border border-border bg-surface px-2.5 text-sm font-medium text-ink-secondary shadow-xs hover:bg-surface-muted focus-ring">
              This month
            </Link>
          ) : null}
          <h2 className="ml-1 text-lg font-semibold tracking-tight text-ink">{monthTitle(month)}</h2>
        </div>
        <ul aria-label="Legend" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
          {kinds.map((k) => {
            const Icon = KIND_META[k].icon;
            return (
              <li key={k} className="inline-flex items-center gap-1">
                <Icon aria-hidden="true" className="size-3.5 text-ink-subtle" />
                {k === "shoot" ? "Shoot date" : "Due date"}
              </li>
            );
          })}
          {lateCount > 0 ? <li className="numeric font-medium text-danger-fg">{lateCount} late</li> : null}
        </ul>
      </div>

      {/* ≥ sm: the grid */}
      <div className="hidden overflow-hidden rounded-lg border border-border bg-surface shadow-xs sm:block">
        <div role="row" className="grid grid-cols-7 border-b border-border bg-surface-muted/60">
          {labels.map((l) => (
            <div key={l.short} role="columnheader" className="px-2 py-2 text-center eyebrow">
              {l.short}
            </div>
          ))}
        </div>
        <div role="grid" aria-label={monthTitle(month)} className="grid grid-cols-7 auto-rows-fr">
          {days.map((d, i) => {
            const list = byDay.get(d) ?? [];
            const inThisMonth = sameMonth(d, monthStart(month));
            const isToday = d === today;
            const extra = list.length - VISIBLE;
            return (
              <div
                key={d}
                role="gridcell"
                aria-label={`${civilLong(d)}: ${list.length} ${list.length === 1 ? "item" : "items"}`}
                className={cn("flex min-h-28 flex-col gap-1 border-border p-1.5 lg:min-h-32", i % 7 !== 6 && "border-r", i < days.length - 7 && "border-b", !inThisMonth && "bg-surface-sunken/60")}
              >
                <div className="flex items-center justify-between">
                  <span className={cn("numeric inline-flex size-6 items-center justify-center rounded-full text-xs font-medium", isToday ? "bg-accent text-accent-fg" : inThisMonth ? "text-ink-secondary" : "text-ink-subtle")}>
                    {parseCivil(d).getDate()}
                  </span>
                  {list.some((e) => e.kind === "due" && e.job.due.late) ? <span aria-hidden="true" className="mr-1 size-1.5 rounded-full bg-danger" /> : null}
                </div>
                <div className="flex min-w-0 flex-col gap-0.5">
                  {list.slice(0, VISIBLE).map((e) => (
                    <EventChip key={e.id} event={e} compact />
                  ))}
                  {extra > 0 ? <span className="numeric px-1.5 text-2xs font-medium text-ink-muted">+{extra} more</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* phones: the month as a list */}
      <div className="sm:hidden">
        {inMonth.length === 0 ? (
          <EmptyState bordered size="sm" title="Nothing this month" description="No shoots or due dates fall in this month for the jobs you can see." />
        ) : (
          <ol className="flex flex-col gap-4">
            {days
              .filter((d) => sameMonth(d, monthStart(month)) && (byDay.get(d)?.length ?? 0) > 0)
              .map((d) => (
                <li key={d} className="flex flex-col gap-1.5">
                  <h3 className={cn("text-sm font-semibold", d === today ? "text-accent-ink" : "text-ink")}>
                    {d === today ? "Today · " : null}
                    {civilLong(d)}
                  </h3>
                  <div className="flex flex-col gap-1">
                    {(byDay.get(d) ?? []).map((e) => (
                      <EventChip key={e.id} event={e} compact={false} />
                    ))}
                  </div>
                </li>
              ))}
          </ol>
        )}
      </div>
    </div>
  );
}
