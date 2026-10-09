/**
 * Server-safe calendar helpers: view/range maths over civil dates
 * ("YYYY-MM-DD" in the organisation timezone) and event colouring.
 *
 * Civil dates are parsed with date-fns as local midnights and formatted back
 * with the same local zone, so the arithmetic is a pure calendar operation —
 * the org timezone enters only through `todayCivil` / `civilDate` upstream.
 */
import {
  addDays,
  addMonths,
  addWeeks,
  endOfMonth,
  endOfWeek,
  format,
  isValid,
  parseISO,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { Camera, Eye, PencilLine, RotateCcw, Send, type LucideIcon } from "lucide-react";
import { PRIORITY_META, STATUS_CATEGORY_META, type StatusCategory } from "@/lib/constants";
import type { CalendarEvent, CalendarEventKind } from "@/lib/types";

export const CALENDAR_VIEWS = ["month", "week", "day", "agenda"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export const COLOUR_MODES = ["status", "priority", "overdue", "editor"] as const;
export type ColourMode = (typeof COLOUR_MODES)[number];

export const COLOUR_MODE_LABELS: Record<ColourMode, string> = {
  status: "Status",
  priority: "Priority",
  overdue: "Overdue",
  editor: "Editor",
};

export type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const EVENT_KIND_META: Record<CalendarEventKind, { label: string; short: string; icon: LucideIcon }> = {
  shoot: { label: "Shoot date", short: "Shoot", icon: Camera },
  due: { label: "Editing deadline", short: "Editing due", icon: PencilLine },
  review_due: { label: "Review deadline", short: "Review due", icon: Eye },
  delivery_due: { label: "Delivery deadline", short: "Delivery due", icon: Send },
  revision_due: { label: "Revision due", short: "Revision due", icon: RotateCcw },
};
export const EVENT_KINDS = Object.keys(EVENT_KIND_META) as CalendarEventKind[];

const CIVIL = /^\d{4}-\d{2}-\d{2}$/;

export function parseCivil(civil: string): Date {
  return parseISO(civil);
}

export function toCivil(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

/** A valid civil date from the URL, or the fallback (today). */
export function normaliseCivil(value: string | undefined, fallback: string): string {
  if (!value || !CIVIL.test(value)) return fallback;
  return isValid(parseISO(value)) ? value : fallback;
}

export function normaliseView(value: string | undefined): CalendarView | null {
  return value && (CALENDAR_VIEWS as readonly string[]).includes(value) ? (value as CalendarView) : null;
}

export function normaliseColourMode(value: string | undefined): ColourMode {
  return value && (COLOUR_MODES as readonly string[]).includes(value) ? (value as ColourMode) : "status";
}

export function normaliseWeekStart(value: number | null | undefined): WeekStart {
  return typeof value === "number" && value >= 0 && value <= 6 ? (Math.floor(value) as WeekStart) : 1;
}

/** Civil days of a view. `null` view = automatic (month grid on desktop, agenda on phones). */
export function viewRange(view: CalendarView | null, date: string, weekStartsOn: WeekStart): { from: string; to: string } {
  const d = parseCivil(date);
  switch (view) {
    case "day":
      return { from: date, to: date };
    case "week":
      return { from: toCivil(startOfWeek(d, { weekStartsOn })), to: toCivil(endOfWeek(d, { weekStartsOn })) };
    case "agenda":
      return { from: toCivil(startOfMonth(d)), to: toCivil(endOfMonth(d)) };
    default:
      return {
        from: toCivil(startOfWeek(startOfMonth(d), { weekStartsOn })),
        to: toCivil(endOfWeek(endOfMonth(d), { weekStartsOn })),
      };
  }
}

/** Every civil day from `from` to `to` inclusive. */
export function civilDays(from: string, to: string): string[] {
  const out: string[] = [];
  let d = parseCivil(from);
  const end = parseCivil(to);
  while (d <= end && out.length < 62) {
    out.push(toCivil(d));
    d = addDays(d, 1);
  }
  return out;
}

/** The date one view-step before/after (prev / next buttons). */
export function shiftDate(view: CalendarView | null, date: string, dir: 1 | -1): string {
  const d = parseCivil(date);
  if (view === "day") return toCivil(addDays(d, dir));
  if (view === "week") return toCivil(addWeeks(d, dir));
  return toCivil(addMonths(d, dir));
}

/** Toolbar heading for the period. */
export function periodTitle(view: CalendarView | null, date: string, weekStartsOn: WeekStart): string {
  const d = parseCivil(date);
  if (view === "day") return format(d, "EEEE d MMMM yyyy");
  if (view === "week") {
    const s = startOfWeek(d, { weekStartsOn });
    const e = endOfWeek(d, { weekStartsOn });
    if (s.getFullYear() !== e.getFullYear()) return `${format(s, "d MMM yyyy")} – ${format(e, "d MMM yyyy")}`;
    if (s.getMonth() !== e.getMonth()) return `${format(s, "d MMM")} – ${format(e, "d MMM yyyy")}`;
    return `${format(s, "d")} – ${format(e, "d MMMM yyyy")}`;
  }
  return format(d, "MMMM yyyy");
}

export function weekdayLabels(weekStartsOn: WeekStart): { short: string; narrow: string }[] {
  const base = startOfWeek(parseCivil("2026-01-05"), { weekStartsOn });
  return Array.from({ length: 7 }, (_, i) => {
    const d = addDays(base, i);
    return { short: format(d, "EEE"), narrow: format(d, "EEEEE") };
  });
}

export function sameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

const NEUTRAL = "#94a3b8";
const DANGER = "var(--color-danger)";
const ATTENTION = "var(--color-attention)";
const DONE = "var(--color-success)";

function isDoneCategory(category: StatusCategory): boolean {
  return STATUS_CATEGORY_META[category]?.done ?? false;
}

/** Overdue / due today / done / upcoming bucket used by the "Overdue" colour mode. */
export function urgencyOf(event: CalendarEvent, day: string, today: string): "overdue" | "today" | "done" | "upcoming" {
  if (event.isOverdue) return "overdue";
  if (event.kind !== "shoot" && isDoneCategory(event.job.statusCategory)) return "done";
  if (event.kind !== "shoot" && day === today) return "today";
  return "upcoming";
}

export const URGENCY_META: Record<ReturnType<typeof urgencyOf>, { label: string; colour: string }> = {
  overdue: { label: "Overdue", colour: DANGER },
  today: { label: "Due today", colour: ATTENTION },
  upcoming: { label: "Upcoming", colour: NEUTRAL },
  done: { label: "Done", colour: DONE },
};

/** The colour an event is drawn in for a colour mode. */
export function eventColour(event: CalendarEvent, mode: ColourMode, day: string, today: string): string {
  switch (mode) {
    case "priority":
      return PRIORITY_META[event.job.priority]?.hex ?? NEUTRAL;
    case "overdue":
      return URGENCY_META[urgencyOf(event, day, today)].colour;
    case "editor":
      return event.job.editor?.avatarColour || NEUTRAL;
    default: {
      const c = event.job.status.colour?.trim();
      return c || STATUS_CATEGORY_META[event.job.statusCategory]?.hex || NEUTRAL;
    }
  }
}

export interface LegendItem {
  key: string;
  label: string;
  colour: string;
}

/** Legend entries for the events on screen (status / editor lists are data-driven). */
export function legendFor(events: readonly CalendarEvent[], mode: ColourMode, dayOf: (e: CalendarEvent) => string, today: string): LegendItem[] {
  if (mode === "priority") {
    return (["urgent", "high", "normal", "low"] as const).map((p) => ({ key: p, label: PRIORITY_META[p].label, colour: PRIORITY_META[p].hex }));
  }
  if (mode === "overdue") {
    return (["overdue", "today", "upcoming", "done"] as const).map((u) => ({ key: u, label: URGENCY_META[u].label, colour: URGENCY_META[u].colour }));
  }
  const seen = new Map<string, LegendItem>();
  for (const e of events) {
    if (mode === "editor") {
      const id = e.job.editor?.id ?? "none";
      if (!seen.has(id)) seen.set(id, { key: id, label: e.job.editor?.name ?? "Unassigned", colour: eventColour(e, mode, dayOf(e), today) });
    } else {
      const id = e.job.status.id;
      if (!seen.has(id)) seen.set(id, { key: id, label: e.job.status.name, colour: eventColour(e, mode, dayOf(e), today) });
    }
  }
  const items = [...seen.values()];
  if (mode === "status") {
    const order = new Map(events.map((e) => [e.job.status.id, e.job.status.sortOrder]));
    items.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
  } else {
    items.sort((a, b) => (a.key === "none" ? 1 : b.key === "none" ? -1 : a.label.localeCompare(b.label)));
  }
  return items;
}
