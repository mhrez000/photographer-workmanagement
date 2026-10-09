"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, ArrowUpRight, CalendarDays, ChevronLeft, ChevronRight, Shapes, X } from "lucide-react";
import { MultiSelect } from "@/components/filters/multi-select";
import { jobHref } from "@/components/jobs/job-link";
import { PersonChip } from "@/components/jobs/person";
import { PriorityPill } from "@/components/jobs/priority-pill";
import { StatusPill, tintStyle } from "@/components/jobs/status-pill";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { useHotkeys } from "@/hooks/use-hotkeys";
import { useUrlState } from "@/hooks/use-url-state";
import { civilDate, formatDate } from "@/lib/dates";
import type { CalendarEvent, CalendarEventKind } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  COLOUR_MODE_LABELS,
  COLOUR_MODES,
  EVENT_KIND_META,
  EVENT_KINDS,
  civilDays,
  eventColour,
  legendFor,
  parseCivil,
  periodTitle,
  sameMonth,
  shiftDate,
  urgencyOf,
  weekdayLabels,
  type CalendarView as View,
  type ColourMode,
  type WeekStart,
} from "./calendar-utils";

export interface CalendarViewProps {
  events: CalendarEvent[];
  /** Explicit view from the URL; null = automatic (month grid ≥ md, agenda on phones). */
  view: View | null;
  /** Anchor civil date of the period. */
  date: string;
  today: string;
  /** Civil range the events were loaded for. */
  range: { from: string; to: string };
  weekStartsOn: WeekStart;
  timeZone: string;
  colourMode: ColourMode;
  kinds: CalendarEventKind[];
}

/* ------------------------------------------------------------------ */
/*  Small hooks                                                        */
/* ------------------------------------------------------------------ */

function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback(
    (cb: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    [query],
  );
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/* ------------------------------------------------------------------ */
/*  Floating detail panel (event summary / "+N more" day list)          */
/* ------------------------------------------------------------------ */

type PanelContent = { type: "event"; event: CalendarEvent; day: string } | { type: "day"; day: string };
interface PanelState {
  content: PanelContent;
  anchor: DOMRect;
  trigger: HTMLElement | null;
}

interface CalendarCtx {
  today: string;
  timeZone: string;
  colourMode: ColourMode;
  dayOf: (e: CalendarEvent) => string;
  eventsByDay: Map<string, CalendarEvent[]>;
  open: (content: PanelContent, trigger: HTMLElement) => void;
}

const Ctx = React.createContext<CalendarCtx | null>(null);
function useCal(): CalendarCtx {
  const c = React.useContext(Ctx);
  if (!c) throw new Error("Calendar context missing");
  return c;
}

/* ------------------------------------------------------------------ */
/*  Root                                                               */
/* ------------------------------------------------------------------ */

/**
 * Calendar of shoot dates and deadlines (spec §10). Month / Week / Day /
 * Agenda; period, view, colour mode and kinds live in the URL. Events open
 * a summary panel; month cells overflow into "+N more".
 */
export function CalendarView({ events, view, date, today, range, weekStartsOn, timeZone, colourMode, kinds }: CalendarViewProps) {
  const url = useUrlState();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const effective: View = view ?? (isMobile ? "agenda" : "month");

  const dayOf = React.useCallback((e: CalendarEvent) => civilDate(e.at, timeZone) ?? e.at.slice(0, 10), [timeZone]);
  const eventsByDay = React.useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const d = dayOf(e);
      const list = map.get(d);
      if (list) list.push(e);
      else map.set(d, [e]);
    }
    return map;
  }, [events, dayOf]);

  const [panel, setPanel] = React.useState<PanelState | null>(null);
  const open = React.useCallback((content: PanelContent, trigger: HTMLElement) => {
    setPanel({ content, anchor: trigger.getBoundingClientRect(), trigger });
  }, []);
  const close = React.useCallback((restoreFocus: boolean) => {
    setPanel((p) => {
      if (restoreFocus && p?.trigger) {
        const trigger = p.trigger;
        window.requestAnimationFrame(() => trigger.focus({ preventScroll: true }));
      }
      return null;
    });
  }, []);

  const go = (patch: Record<string, string | null>) => {
    setPanel(null);
    url.patch(patch);
  };
  const step = (dir: 1 | -1) => go({ date: shiftDate(view, date, dir) });

  useHotkeys({
    t: () => go({ date: today }),
    "[": () => step(-1),
    "]": () => step(1),
  });

  const visibleEvents = React.useMemo(() => {
    if (effective === "agenda" && !view) return events.filter((e) => sameMonth(dayOf(e), date));
    return events;
  }, [effective, view, events, dayOf, date]);
  const overdue = visibleEvents.filter((e) => e.isOverdue).length;
  const legend = legendFor(visibleEvents, colourMode, dayOf, today);

  const ctx: CalendarCtx = { today, timeZone, colourMode, dayOf, eventsByDay, open };

  return (
    <Ctx.Provider value={ctx}>
      <div className="flex flex-col gap-4">
        {/* Toolbar */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <IconButton label="Previous period ([)" variant="outline" size="sm" onClick={() => step(-1)}>
                <ChevronLeft />
              </IconButton>
              <IconButton label="Next period (])" variant="outline" size="sm" onClick={() => step(1)}>
                <ChevronRight />
              </IconButton>
            </div>
            <Button variant="outline" size="sm" onClick={() => go({ date: today })} disabled={date === today} title="Today (t)">
              Today
            </Button>
            <h2 className={cn("ml-1 truncate text-lg font-semibold tracking-tight text-ink", url.isPending && "opacity-60")} aria-live="polite">
              {periodTitle(view ?? (effective === "agenda" ? "agenda" : "month"), date, weekStartsOn)}
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl<View>
              aria-label="Calendar view"
              size="sm"
              value={effective}
              onValueChange={(v) => go({ view: v })}
              options={[
                { value: "month", label: "Month" },
                { value: "week", label: "Week" },
                { value: "day", label: "Day" },
                { value: "agenda", label: "Agenda" },
              ]}
            />
            <MultiSelect
              label="Kind"
              icon={Shapes}
              options={EVENT_KINDS.map((k) => ({ value: k, label: EVENT_KIND_META[k].label }))}
              value={kinds}
              onChange={(next) => url.set("kinds", next.length === EVENT_KINDS.length ? null : next)}
              searchable={false}
              align="end"
            />
            <label className="flex items-center gap-2 text-sm text-ink-muted">
              <span className="shrink-0">Colour by</span>
              <Select
                size="sm"
                aria-label="Colour events by"
                value={colourMode}
                onChange={(e) => url.set("colour", e.target.value === "status" ? null : e.target.value)}
                options={COLOUR_MODES.map((m) => ({ value: m, label: COLOUR_MODE_LABELS[m] }))}
                wrapperClassName="w-32"
              />
            </label>
          </div>
        </div>

        {/* Legend + summary */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-muted">
          <span className="numeric font-medium text-ink-secondary">
            {visibleEvents.length} {visibleEvents.length === 1 ? "event" : "events"}
          </span>
          {overdue > 0 ? (
            <span className="numeric inline-flex items-center gap-1 font-medium text-danger-fg">
              <AlertTriangle aria-hidden="true" className="size-3.5" />
              {overdue} overdue
            </span>
          ) : null}
          <span aria-hidden="true" className="hidden h-3 w-px bg-border sm:block" />
          <ul aria-label="Event kinds" className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {EVENT_KINDS.filter((k) => kinds.includes(k)).map((k) => {
              const Icon = EVENT_KIND_META[k].icon;
              return (
                <li key={k} className="inline-flex items-center gap-1">
                  <Icon aria-hidden="true" className="size-3.5 text-ink-subtle" />
                  {EVENT_KIND_META[k].short}
                </li>
              );
            })}
          </ul>
          {legend.length > 0 ? (
            <>
              <span aria-hidden="true" className="hidden h-3 w-px bg-border sm:block" />
              <ul aria-label={`Colours: ${COLOUR_MODE_LABELS[colourMode]}`} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {legend.slice(0, 12).map((item) => (
                  <li key={item.key} className="inline-flex items-center gap-1.5">
                    <span aria-hidden="true" className="inline-flex items-center -space-x-0.5">
                      {item.colours.map((c) => (
                        <span key={c} className="size-2 rounded-full ring-1 ring-canvas" style={{ backgroundColor: c }} />
                      ))}
                    </span>
                    {item.label}
                  </li>
                ))}
                {legend.length > 12 ? <li className="numeric">+{legend.length - 12} more</li> : null}
              </ul>
            </>
          ) : null}
        </div>

        <div className={cn("transition-opacity duration-(--motion-fast)", url.isPending && "opacity-60")}>
          {view === null ? (
            <>
              <div className="hidden md:block">
                <MonthGrid date={date} range={range} weekStartsOn={weekStartsOn} onOpenDay={(d) => go({ view: "day", date: d })} />
              </div>
              <div className="md:hidden">
                <AgendaList days={civilDays(range.from, range.to).filter((d) => sameMonth(d, date))} />
              </div>
            </>
          ) : view === "month" ? (
            <MonthGrid date={date} range={range} weekStartsOn={weekStartsOn} onOpenDay={(d) => go({ view: "day", date: d })} />
          ) : view === "week" ? (
            <WeekGrid days={civilDays(range.from, range.to)} onOpenDay={(d) => go({ view: "day", date: d })} />
          ) : view === "day" ? (
            <DayList day={date} />
          ) : (
            <AgendaList days={civilDays(range.from, range.to)} />
          )}
        </div>
      </div>

      {panel ? (
        <FloatingPanel
          key={`${panel.anchor.left}:${panel.anchor.top}:${panel.content.type}`}
          state={panel}
          onClose={close}
          onOpenDay={(d) => go({ view: "day", date: d })}
        />
      ) : null}
    </Ctx.Provider>
  );
}

/* ------------------------------------------------------------------ */
/*  Event chip                                                         */
/* ------------------------------------------------------------------ */

function EventChip({ event, day, variant = "compact" }: { event: CalendarEvent; day: string; variant?: "compact" | "card" }) {
  const { colourMode, today, open } = useCal();
  const colour = eventColour(event, colourMode, day, today);
  const meta = EVENT_KIND_META[event.kind];
  const Icon = meta.icon;
  const done = event.kind !== "shoot" && urgencyOf(event, day, today) === "done";
  const label = `${meta.short}: ${event.job.jobNumber} ${event.job.name}${event.isOverdue ? " (overdue)" : ""}`;

  if (variant === "card") {
    return (
      <button
        type="button"
        aria-label={label}
        onClick={(e) => open({ type: "event", event, day }, e.currentTarget)}
        className={cn(
          "group flex w-full flex-col gap-1.5 rounded-md border bg-surface p-2.5 text-left shadow-xs transition-[border-color,box-shadow] focus-ring",
          "hover:border-border-hover hover:shadow-sm",
          event.isOverdue ? "border-danger/50" : "border-border",
        )}
        style={{ boxShadow: `inset 3px 0 0 ${colour}` }}
      >
        <span className="flex items-center justify-between gap-2 text-2xs">
          <span className={cn("inline-flex items-center gap-1 font-medium", event.isOverdue ? "text-danger-fg" : "text-ink-muted")}>
            <Icon aria-hidden="true" className="size-3.5" />
            {meta.short}
            {event.revisionNumber ? <span className="numeric">· R{event.revisionNumber}</span> : null}
          </span>
          {event.isOverdue ? (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-danger-soft px-1.5 py-0.5 font-semibold text-danger-fg">Overdue</span>
          ) : null}
        </span>
        <span className={cn("line-clamp-2 text-sm font-medium leading-snug text-ink", done && "text-ink-muted line-through decoration-ink-subtle")}>
          {event.job.name}
        </span>
        <span className="flex items-center justify-between gap-2">
          <span className="numeric text-2xs font-semibold text-ink-muted">{event.job.jobNumber}</span>
          <PersonChip user={event.job.editor} size="xs" avatarOnly emptyLabel="No editor" />
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => open({ type: "event", event, day }, e.currentTarget)}
      className={cn(
        "flex h-6 w-full min-w-0 items-center gap-1 rounded-sm px-1.5 text-left text-2xs leading-none focus-ring transition-[filter] hover:brightness-95",
        event.isOverdue && "font-semibold ring-1 ring-inset ring-danger/60",
        done && "opacity-60",
      )}
      style={tintStyle(colour)}
    >
      {event.isOverdue ? (
        <AlertTriangle aria-hidden="true" className="size-3 shrink-0 text-danger" />
      ) : (
        <Icon aria-hidden="true" className="size-3 shrink-0" />
      )}
      <span className="numeric shrink-0 opacity-80">{event.job.jobNumber}</span>
      <span className={cn("truncate", done && "line-through")}>{event.job.name}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Month                                                              */
/* ------------------------------------------------------------------ */

const MONTH_VISIBLE = 3;

function MonthGrid({ date, range, weekStartsOn, onOpenDay }: { date: string; range: { from: string; to: string }; weekStartsOn: WeekStart; onOpenDay: (day: string) => void }) {
  const { eventsByDay, today, open, colourMode, dayOf } = useCal();
  const days = civilDays(range.from, range.to);
  const labels = weekdayLabels(weekStartsOn);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
      <div role="row" className="grid grid-cols-7 border-b border-border bg-surface-muted/60">
        {labels.map((l) => (
          <div key={l.short} role="columnheader" className="px-2 py-2 text-center eyebrow">
            <span className="hidden sm:inline">{l.short}</span>
            <span className="sm:hidden">{l.narrow}</span>
          </div>
        ))}
      </div>
      <div role="grid" aria-label="Month" className="grid grid-cols-7 auto-rows-fr">
        {days.map((d, i) => {
          const list = eventsByDay.get(d) ?? [];
          const inMonth = sameMonth(d, date);
          const isToday = d === today;
          const overdue = list.some((e) => e.isOverdue);
          const extra = list.length - MONTH_VISIBLE;
          const dayNum = parseCivil(d).getDate();
          return (
            <div
              key={d}
              role="gridcell"
              aria-label={`${formatDate(d)}: ${list.length} ${list.length === 1 ? "event" : "events"}`}
              className={cn(
                "group/cell relative flex min-h-20 flex-col gap-1 border-border p-1 sm:min-h-28 sm:p-1.5 lg:min-h-32",
                i % 7 !== 6 && "border-r",
                i < days.length - 7 && "border-b",
                !inMonth && "bg-surface-sunken/60",
              )}
            >
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => onOpenDay(d)}
                  aria-label={`Open ${formatDate(d)} in day view`}
                  className={cn(
                    "numeric inline-flex size-6 items-center justify-center rounded-full text-xs font-medium focus-ring transition-colors",
                    isToday ? "bg-accent text-accent-fg" : inMonth ? "text-ink-secondary hover:bg-surface-muted" : "text-ink-subtle hover:bg-surface-muted",
                  )}
                >
                  {dayNum}
                </button>
                {overdue ? <span aria-hidden="true" className="mr-1 size-1.5 rounded-full bg-danger" /> : null}
              </div>

              {/* ≥ sm: chips; phones: colour dots that open the day list */}
              <div className="hidden min-w-0 flex-col gap-0.5 sm:flex">
                {list.slice(0, MONTH_VISIBLE).map((e) => (
                  <EventChip key={e.id} event={e} day={d} />
                ))}
                {extra > 0 ? (
                  <button
                    type="button"
                    onClick={(ev) => open({ type: "day", day: d }, ev.currentTarget)}
                    className="numeric h-5 rounded-sm px-1.5 text-left text-2xs font-medium text-ink-muted hover:bg-surface-muted hover:text-ink focus-ring"
                  >
                    +{extra} more
                  </button>
                ) : null}
              </div>
              {list.length > 0 ? (
                <button
                  type="button"
                  onClick={(ev) => open({ type: "day", day: d }, ev.currentTarget)}
                  aria-label={`${list.length} events on ${formatDate(d)}`}
                  className="flex flex-wrap gap-0.5 rounded-sm p-0.5 focus-ring sm:hidden"
                >
                  {list.slice(0, 6).map((e) => (
                    <span key={e.id} aria-hidden="true" className="size-1.5 rounded-full" style={{ backgroundColor: eventColour(e, colourMode, dayOf(e), today) }} />
                  ))}
                  {list.length > 6 ? <span className="numeric text-[9px] leading-none text-ink-muted">+{list.length - 6}</span> : null}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Week / Day / Agenda                                                */
/* ------------------------------------------------------------------ */

function DayHeading({ day, count, onOpenDay }: { day: string; count: number; onOpenDay?: (day: string) => void }) {
  const { today } = useCal();
  const d = parseCivil(day);
  const isToday = day === today;
  const body = (
    <>
      <span className="eyebrow">{d.toLocaleDateString("en-AU", { weekday: "short" })}</span>
      <span className={cn("numeric inline-flex size-7 items-center justify-center rounded-full text-sm font-semibold", isToday ? "bg-accent text-accent-fg" : "text-ink")}>
        {d.getDate()}
      </span>
      <span className="numeric ml-auto text-2xs text-ink-subtle">{count > 0 ? count : ""}</span>
    </>
  );
  return onOpenDay ? (
    <button type="button" onClick={() => onOpenDay(day)} className="flex w-full items-center gap-2 rounded-sm text-left focus-ring" aria-label={`Open ${formatDate(day)} in day view`}>
      {body}
    </button>
  ) : (
    <div className="flex items-center gap-2">{body}</div>
  );
}

function WeekGrid({ days, onOpenDay }: { days: string[]; onOpenDay: (day: string) => void }) {
  const { eventsByDay, today } = useCal();
  return (
    <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border shadow-xs md:grid-cols-7">
      {days.map((d) => {
        const list = eventsByDay.get(d) ?? [];
        return (
          <section key={d} aria-label={formatDate(d)} className={cn("flex min-h-24 flex-col gap-2 bg-surface p-2 md:min-h-[26rem]", d === today && "bg-accent-soft/25")}>
            <DayHeading day={d} count={list.length} onOpenDay={onOpenDay} />
            <div className="flex flex-col gap-1.5">
              {list.map((e) => (
                <EventChip key={e.id} event={e} day={d} variant="card" />
              ))}
              {list.length === 0 ? <p className="hidden py-2 text-center text-2xs text-ink-subtle md:block">—</p> : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function DayList({ day }: { day: string }) {
  const { eventsByDay, today } = useCal();
  const list = eventsByDay.get(day) ?? [];
  if (list.length === 0) {
    return (
      <EmptyState
        bordered
        icon={CalendarDays}
        title={day === today ? "Nothing scheduled today" : "Nothing scheduled this day"}
        description="No shoots or deadlines fall on this date for the jobs and filters you can see."
      />
    );
  }
  const byKind = EVENT_KINDS.map((k) => ({ kind: k, items: list.filter((e) => e.kind === k) })).filter((g) => g.items.length > 0);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {byKind.map((g) => {
        const Icon = EVENT_KIND_META[g.kind].icon;
        return (
          <section key={g.kind} aria-label={EVENT_KIND_META[g.kind].label} className="flex flex-col gap-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Icon aria-hidden="true" className="size-4 text-ink-muted" />
              {EVENT_KIND_META[g.kind].label}
              <span className="numeric font-normal text-ink-subtle">{g.items.length}</span>
            </h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {g.items.map((e) => (
                <EventChip key={e.id} event={e} day={day} variant="card" />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function AgendaList({ days }: { days: string[] }) {
  const { eventsByDay, today } = useCal();
  const withEvents = days.filter((d) => (eventsByDay.get(d)?.length ?? 0) > 0);
  if (withEvents.length === 0) {
    return (
      <EmptyState
        bordered
        icon={CalendarDays}
        title="Nothing scheduled in this period"
        description="No shoots or deadlines for the jobs and filters you can see. Try the next month or clear a filter."
      />
    );
  }
  return (
    <ol className="flex flex-col gap-5">
      {withEvents.map((d) => {
        const list = eventsByDay.get(d) ?? [];
        return (
          <li key={d} className="flex flex-col gap-2">
            <h3 className={cn("flex items-baseline gap-2 text-sm font-semibold", d === today ? "text-accent-ink" : "text-ink")}>
              {d === today ? "Today · " : null}
              {parseCivil(d).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })}
              <span className="numeric text-xs font-normal text-ink-subtle">{list.length}</span>
            </h3>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((e) => (
                <EventChip key={e.id} event={e} day={d} variant="card" />
              ))}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/*  Floating panel                                                     */
/* ------------------------------------------------------------------ */

const PANEL_WIDTH = 320;

function FloatingPanel({ state, onClose, onOpenDay }: { state: PanelState; onClose: (restoreFocus: boolean) => void; onOpenDay: (day: string) => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [content, setContent] = React.useState<PanelContent>(state.content);

  React.useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || state.trigger?.contains(t)) return;
      onClose(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose(true);
      }
    };
    const onResize = () => onClose(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose, state.trigger]);

  // Phones: bottom sheet above the tab bar. Larger screens: anchored to the trigger, flipped/clamped to the viewport.
  const [style] = React.useState<React.CSSProperties | null>(() => {
    if (typeof window === "undefined" || window.innerWidth < 640) return null;
    const a = state.anchor;
    const left = Math.min(Math.max(8, a.left), window.innerWidth - PANEL_WIDTH - 8);
    const below = window.innerHeight - a.bottom;
    return below > 300 || below > a.top ? { left, top: a.bottom + 6, width: PANEL_WIDTH } : { left, bottom: window.innerHeight - a.top + 6, width: PANEL_WIDTH };
  });

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-label={content.type === "event" ? `${content.event.job.jobNumber} details` : `Events on ${formatDate(content.day)}`}
      tabIndex={-1}
      style={style ?? undefined}
      className={cn(
        "fixed z-50 max-h-[min(70vh,28rem)] overflow-y-auto rounded-lg border border-border bg-surface-raised p-4 text-ink shadow-pop outline-none scrollbar-thin",
        style ? "animate-scale-in" : "inset-x-3 bottom-[calc(var(--tabbar-height,0px)+env(safe-area-inset-bottom,0px)+0.75rem)] animate-slide-in-bottom",
      )}
    >
      <div className="absolute right-2 top-2">
        <IconButton label="Close" variant="ghost" size="sm" onClick={() => onClose(true)}>
          <X />
        </IconButton>
      </div>
      {content.type === "event" ? (
        <EventSummary event={content.event} day={content.day} />
      ) : (
        <DaySummary day={content.day} onPick={(event) => setContent({ type: "event", event, day: content.day })} onOpenDay={onOpenDay} />
      )}
    </div>
  );
}

function EventSummary({ event, day }: { event: CalendarEvent; day: string }) {
  const { timeZone, today } = useCal();
  const meta = EVENT_KIND_META[event.kind];
  const Icon = meta.icon;
  const urgency = urgencyOf(event, day, today);
  return (
    <div className="flex flex-col gap-3 pr-6">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1 font-medium text-ink-muted">
          <Icon aria-hidden="true" className="size-3.5" />
          {meta.label}
          {event.revisionNumber ? <span className="numeric">· Revision {event.revisionNumber}</span> : null}
        </span>
        {urgency === "overdue" ? (
          <span className="rounded-full bg-danger-soft px-1.5 py-0.5 font-semibold text-danger-fg">Overdue</span>
        ) : urgency === "today" ? (
          <span className="rounded-full bg-attention-soft px-1.5 py-0.5 font-semibold text-attention-fg">Due today</span>
        ) : null}
      </div>
      <div>
        <p className="numeric text-2xs font-semibold tracking-wide text-ink-muted">{event.job.jobNumber}</p>
        <p className="mt-0.5 text-base font-semibold leading-snug text-ink">{event.job.name}</p>
        <p className="numeric mt-1 text-sm text-ink-secondary">{formatDate(event.at, timeZone)}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusPill status={event.job.status} size="sm" />
        <PriorityPill priority={event.job.priority} quietNormal />
      </div>
      <dl className="grid grid-cols-2 gap-3 border-t border-border pt-3">
        <div className="min-w-0">
          <dt className="eyebrow mb-1">Editor</dt>
          <dd>
            <PersonChip user={event.job.editor} size="xs" />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="eyebrow mb-1">Photographer</dt>
          <dd>
            <PersonChip user={event.job.photographer} size="xs" />
          </dd>
        </div>
      </dl>
      <div className="flex gap-2 pt-1">
        <Button href={jobHref(event.job.id)} size="sm" trailingIcon={<ArrowUpRight aria-hidden="true" />}>
          Open job
        </Button>
        <Button href={jobHref(event.job.id, "history")} size="sm" variant="ghost">
          History
        </Button>
      </div>
    </div>
  );
}

function DaySummary({ day, onPick, onOpenDay }: { day: string; onPick: (e: CalendarEvent) => void; onOpenDay: (day: string) => void }) {
  const { eventsByDay, colourMode, today } = useCal();
  const list = eventsByDay.get(day) ?? [];
  return (
    <div className="flex flex-col gap-3">
      <div className="pr-8">
        <p className="eyebrow">{list.length} {list.length === 1 ? "event" : "events"}</p>
        <p className="text-base font-semibold text-ink">{parseCivil(day).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })}</p>
      </div>
      <ul className="flex flex-col gap-1">
        {list.map((e) => {
          const Icon = EVENT_KIND_META[e.kind].icon;
          return (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => onPick(e)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-muted focus-ring"
              >
                <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: eventColour(e, colourMode, day, today) }} />
                <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", e.isOverdue ? "text-danger" : "text-ink-subtle")} />
                <span className="numeric shrink-0 text-2xs font-semibold text-ink-muted">{e.job.jobNumber}</span>
                <span className={cn("truncate", e.isOverdue && "font-medium text-danger-fg")}>{e.job.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <Button variant="outline" size="sm" onClick={() => onOpenDay(day)}>
        Open day view
      </Button>
      <Link href={`/workspace/all?dueFrom=${day}&dueTo=${day}`} className="text-center text-xs text-ink-muted hover:text-ink hover:underline focus-ring rounded-xs">
        See jobs due this day in All Work
      </Link>
    </div>
  );
}
