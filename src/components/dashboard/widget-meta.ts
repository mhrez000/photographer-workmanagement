import type { LucideIcon } from "lucide-react";
import {
  Activity,
  AlarmClock,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  Camera,
  CircleCheckBig,
  ClipboardCheck,
  MessageCircleQuestion,
  Gauge,
  LayoutGrid,
  Percent,
  RotateCcw,
  Timer,
  TriangleAlert,
  Trophy,
  UserRound,
  Users,
} from "lucide-react";
import type { DashboardWidgetType } from "@/lib/constants";

export interface WidgetMeta {
  label: string;
  /** One line for the widget picker in customise mode. */
  description: string;
  icon: LucideIcon;
  /** Width (of 12) a widget gets when added from the picker. */
  defaultWidth: number;
}

/** Display metadata for every DASHBOARD_WIDGET_TYPES entry (labels, picker copy, icons). */
export const WIDGET_META: Record<DashboardWidgetType, WidgetMeta> = {
  kpis: { label: "Key numbers", description: "Active, due today, overdue and every stage at a glance.", icon: LayoutGrid, defaultWidth: 12 },
  bottlenecks: { label: "Bottlenecks", description: "Alerts when reviews, editors or revisions pile up.", icon: TriangleAlert, defaultWidth: 12 },
  team_workload: { label: "Editor workload", description: "Who is overloaded, near capacity or has room.", icon: Users, defaultWidth: 12 },
  my_workload: { label: "My workload", description: "Your capacity and the next jobs in your queue.", icon: UserRound, defaultWidth: 6 },
  my_performance: { label: "My performance", description: "Your last 30 days: completed, turnaround, revisions.", icon: Gauge, defaultWidth: 6 },
  due_today: { label: "Due today", description: "Jobs whose editing deadline is later today.", icon: CalendarClock, defaultWidth: 6 },
  overdue: { label: "Overdue", description: "Jobs past their editing deadline, most late first.", icon: AlarmClock, defaultWidth: 6 },
  recent_activity: { label: "Recent activity", description: "The latest moves, assignments and revisions.", icon: Activity, defaultWidth: 6 },
  recent_completed: { label: "Recently delivered & completed", description: "Finished work from the last 14 days, with delivery links.", icon: CircleCheckBig, defaultWidth: 6 },
  editor_performance: { label: "Editor performance", description: "This month's completions, turnaround and on-time rate.", icon: Trophy, defaultWidth: 6 },
  completion_rate: { label: "On-time completion", description: "Share of this month's approved jobs delivered on time.", icon: Percent, defaultWidth: 3 },
  revision_rate: { label: "Revision rate", description: "Share of this month's approved jobs that needed revisions.", icon: RotateCcw, defaultWidth: 3 },
  calendar: { label: "Next 7 days", description: "Shoots and editing deadlines for the week ahead.", icon: CalendarDays, defaultWidth: 4 },
  // Roles v2 (docs/ROLES.md §9)
  my_shoots: { label: "My shoots", description: "Active jobs where you are the photographer, by next step.", icon: Camera, defaultWidth: 6 },
  awaiting_review: { label: "Awaiting review", description: "Submitted work waiting for a review, oldest first.", icon: ClipboardCheck, defaultWidth: 6 },
  questions: { label: "Questions & client feedback", description: "Editors waiting for answers and client threads waiting for you.", icon: MessageCircleQuestion, defaultWidth: 6 },
  upcoming_deadlines: { label: "Upcoming deadlines", description: "Editing, review and delivery dates in the next 7 days.", icon: CalendarRange, defaultWidth: 6 },
  revisions: { label: "Revisions", description: "Open revisions and resubmissions.", icon: RotateCcw, defaultWidth: 6 },
  turnaround: { label: "Turnaround", description: "Median shoot → delivery and submit → review, vs the previous 30 days.", icon: Timer, defaultWidth: 6 },
};

/** Widths offered in customise mode (of a 12-column grid). */
export const WIDGET_WIDTHS = [
  { value: 3, label: "S" },
  { value: 4, label: "M" },
  { value: 6, label: "L" },
  { value: 8, label: "XL" },
  { value: 12, label: "Full" },
] as const;

/** Grid column classes per stored width (static strings so Tailwind sees them). */
export function widgetSpanClass(width: number): string {
  const xl: Record<number, string> = {
    1: "xl:col-span-3",
    2: "xl:col-span-3",
    3: "xl:col-span-3",
    4: "xl:col-span-4",
    5: "xl:col-span-5",
    6: "xl:col-span-6",
    7: "xl:col-span-7",
    8: "xl:col-span-8",
    9: "xl:col-span-9",
    10: "xl:col-span-10",
    11: "xl:col-span-11",
    12: "xl:col-span-12",
  };
  const md = width > 6 ? "md:col-span-12" : "md:col-span-6";
  return `${md} ${xl[width] ?? "xl:col-span-12"}`;
}
