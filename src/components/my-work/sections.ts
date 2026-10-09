import type { LucideIcon } from "lucide-react";
import { AlarmClock, CalendarClock, CalendarRange, CalendarX2, Eye, PauseCircle, RotateCcw, Send } from "lucide-react";
import type { Role } from "@/lib/constants";
import type { MyWorkQueue } from "@/lib/types";

/** The seven exclusive buckets of `MyWorkQueue` (runningSession excluded). */
export type MyWorkSectionKey = Exclude<keyof MyWorkQueue, "runningSession">;

/** Whose eyes the queue is seen through: the editor doing the work, or the reviewer (photographer / manager / owner). */
export type MyWorkPerspective = "editor" | "reviewer";

/** Icons are referenced by key so section metadata can cross the server → client boundary. */
export const SECTION_ICONS = {
  overdue: CalendarX2,
  today: AlarmClock,
  tomorrow: CalendarClock,
  upcoming: CalendarRange,
  revision: RotateCcw,
  submitted: Send,
  review: Eye,
  paused: PauseCircle,
} satisfies Record<string, LucideIcon>;
export type SectionIconKey = keyof typeof SECTION_ICONS;

export type SectionTone = "danger" | "attention" | "revision" | "accent" | "neutral" | "warning";

export interface MyWorkSectionMeta {
  key: MyWorkSectionKey;
  title: string;
  /** Shorter label for the summary strip. */
  short: string;
  description: string;
  /** Copy for an empty section (calm, a little celebratory). */
  empty: string;
  icon: SectionIconKey;
  tone: SectionTone;
  /** Collapsed on first visit (the viewer's choice is remembered afterwards). */
  defaultCollapsed?: boolean;
}

export function perspectiveOf(role: Role): MyWorkPerspective {
  return role === "editor" ? "editor" : "reviewer";
}

const BASE: Record<MyWorkSectionKey, Omit<MyWorkSectionMeta, "key">> = {
  overdue: {
    title: "Overdue",
    short: "Overdue",
    description: "Past the editing deadline — start here.",
    empty: "Nothing overdue. Every deadline is on track.",
    icon: "overdue",
    tone: "danger",
  },
  dueToday: {
    title: "Due today",
    short: "Today",
    description: "Due before the end of today.",
    empty: "Nothing else is due today.",
    icon: "today",
    tone: "attention",
  },
  dueTomorrow: {
    title: "Due tomorrow",
    short: "Tomorrow",
    description: "Line these up next.",
    empty: "Nothing due tomorrow yet.",
    icon: "tomorrow",
    tone: "warning",
  },
  upcoming: {
    title: "Upcoming",
    short: "Upcoming",
    description: "Later deadlines, and jobs without a due date.",
    empty: "No upcoming work queued.",
    icon: "upcoming",
    tone: "neutral",
  },
  revisionRequired: {
    title: "Revision required",
    short: "Revisions",
    description: "Sent back with changes requested.",
    empty: "No revisions waiting. Clean first passes.",
    icon: "revision",
    tone: "revision",
  },
  waitingForReview: {
    title: "Waiting for review",
    short: "In review",
    description: "Submitted and with the reviewer.",
    empty: "Nothing waiting on a reviewer.",
    icon: "submitted",
    tone: "accent",
  },
  paused: {
    title: "Paused",
    short: "Paused",
    description: "On hold — resume when you are ready.",
    empty: "Nothing on hold.",
    icon: "paused",
    tone: "neutral",
    defaultCollapsed: true,
  },
};

const EDITOR_ORDER: MyWorkSectionKey[] = ["overdue", "dueToday", "dueTomorrow", "upcoming", "revisionRequired", "waitingForReview", "paused"];
const REVIEWER_ORDER: MyWorkSectionKey[] = ["waitingForReview", "overdue", "dueToday", "dueTomorrow", "upcoming", "revisionRequired", "paused"];

/** Ordered section metadata for a perspective (reviewers get their Review queue first). */
export function sectionsFor(perspective: MyWorkPerspective): MyWorkSectionMeta[] {
  const order = perspective === "editor" ? EDITOR_ORDER : REVIEWER_ORDER;
  return order.map((key) => {
    const base = BASE[key];
    if (key === "waitingForReview" && perspective === "reviewer") {
      return {
        key,
        ...base,
        title: "Review queue",
        short: "To review",
        description: "Submitted work awaiting your review — approve or request changes.",
        empty: "Nothing waiting for your review.",
        icon: "review",
        tone: "accent",
      };
    }
    if (key === "waitingForReview" && perspective === "editor") {
      return { key, ...base, defaultCollapsed: true };
    }
    if (key === "revisionRequired" && perspective === "reviewer") {
      return { key, ...base, description: "Sent back to the editor — waiting on their changes." };
    }
    return { key, ...base };
  });
}

/** Tailwind classes per tone (icon chip, count, card accent rail). */
export const SECTION_TONE_CLASSES: Record<SectionTone, { chip: string; count: string; rail: string }> = {
  danger: { chip: "bg-danger-soft text-danger", count: "text-danger-fg", rail: "bg-danger" },
  attention: { chip: "bg-attention-soft text-attention", count: "text-attention-fg", rail: "bg-attention" },
  warning: { chip: "bg-warning-soft text-warning", count: "text-warning-fg", rail: "bg-warning" },
  revision: { chip: "bg-status-revision-soft text-status-revision-fg", count: "text-status-revision-fg", rail: "bg-status-revision" },
  accent: { chip: "bg-accent-soft text-accent-ink", count: "text-accent-ink", rail: "bg-accent" },
  neutral: { chip: "bg-surface-muted text-ink-muted", count: "text-ink", rail: "bg-border-strong" },
};

export const sectionAnchor = (key: MyWorkSectionKey) => `my-work-${key}`;
