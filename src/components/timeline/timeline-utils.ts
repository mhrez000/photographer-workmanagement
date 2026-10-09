/**
 * Server-safe Gantt helpers: stage vocabulary (spec §11: Assignment → Editing
 * → Review → Revision → Approval → Delivery), window maths over civil dates
 * and grouping. Colours come from the status-category tokens.
 */
import { addDays, format, parseISO, startOfWeek } from "date-fns";
import { STATUS_CATEGORY_META, type StatusCategory } from "@/lib/constants";
import type { TimelineRow } from "@/lib/types";

export const TIMELINE_WINDOWS = [2, 4, 8] as const;
export type TimelineWindow = (typeof TIMELINE_WINDOWS)[number];

export const TIMELINE_GROUPS = ["editor", "photographer", "project", "job"] as const;
export type TimelineGroup = (typeof TIMELINE_GROUPS)[number];
export const TIMELINE_GROUP_LABELS: Record<TimelineGroup, string> = {
  editor: "Editor",
  photographer: "Photographer",
  project: "Project",
  job: "Job",
};

export interface StageMeta {
  key: string;
  label: string;
  categories: readonly StatusCategory[];
  colour: string;
}

/** Stages in workflow order; each bar keeps its own category colour. */
export const TIMELINE_STAGES: readonly StageMeta[] = [
  { key: "intake", label: "Intake", categories: ["new", "ready"], colour: STATUS_CATEGORY_META.ready.hex },
  { key: "assignment", label: "Assignment", categories: ["assigned", "accepted"], colour: STATUS_CATEGORY_META.assigned.hex },
  { key: "editing", label: "Editing", categories: ["in_progress"], colour: STATUS_CATEGORY_META.in_progress.hex },
  { key: "review", label: "Review", categories: ["submitted", "review", "resubmitted"], colour: STATUS_CATEGORY_META.review.hex },
  { key: "revision", label: "Revision", categories: ["revision"], colour: STATUS_CATEGORY_META.revision.hex },
  { key: "approval", label: "Approval", categories: ["approved"], colour: STATUS_CATEGORY_META.approved.hex },
  { key: "delivery", label: "Delivery", categories: ["delivered"], colour: STATUS_CATEGORY_META.delivered.hex },
];

export function stageOf(category: StatusCategory): StageMeta {
  return TIMELINE_STAGES.find((s) => s.categories.includes(category)) ?? { key: category, label: STATUS_CATEGORY_META[category]?.label ?? category, categories: [category], colour: STATUS_CATEGORY_META[category]?.hex ?? "#94a3b8" };
}

export function categoryColour(category: StatusCategory): string {
  return STATUS_CATEGORY_META[category]?.hex ?? "#94a3b8";
}

export function normaliseWindow(value: string | undefined): TimelineWindow {
  const n = Number(value);
  return (TIMELINE_WINDOWS as readonly number[]).includes(n) ? (n as TimelineWindow) : 4;
}

export function normaliseGroup(value: string | undefined): TimelineGroup {
  return value && (TIMELINE_GROUPS as readonly string[]).includes(value) ? (value as TimelineGroup) : "editor";
}

/** Default first day: a week boundary that keeps "today" left of centre with some future visible. */
export function defaultWindowStart(today: string, weeks: TimelineWindow, weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6): string {
  const start = startOfWeek(parseISO(today), { weekStartsOn });
  return format(addDays(start, -7 * Math.floor((weeks - 1) / 2)), "yyyy-MM-dd");
}

export function shiftCivil(civil: string, days: number): string {
  return format(addDays(parseISO(civil), days), "yyyy-MM-dd");
}

export interface TimelineGroupView {
  key: string;
  label: string;
  person: TimelineRow["job"]["editor"];
  sublabel?: string;
  rows: TimelineRow[];
}

/** Rows grouped for the chosen mode (the query already sorts editor/photographer groups). */
export function groupRows(rows: readonly TimelineRow[], mode: TimelineGroup): TimelineGroupView[] {
  if (mode === "job") {
    const sorted = [...rows].sort((a, b) => (a.segments[0]?.startAt ?? "").localeCompare(b.segments[0]?.startAt ?? ""));
    return [{ key: "all", label: "All jobs", person: null, rows: sorted }];
  }
  const groups = new Map<string, TimelineGroupView>();
  for (const row of rows) {
    let key: string;
    let label: string;
    let person: TimelineGroupView["person"] = null;
    let sublabel: string | undefined;
    if (mode === "project") {
      key = row.job.project?.id ?? "none";
      label = row.job.project?.name ?? "No project";
      sublabel = row.job.client?.name;
    } else {
      const p = mode === "editor" ? row.job.editor : row.job.photographer;
      key = p?.id ?? "none";
      label = p?.name ?? (mode === "editor" ? "Unassigned" : "No photographer");
      person = p;
    }
    const g = groups.get(key);
    if (g) g.rows.push(row);
    else groups.set(key, { key, label, person, sublabel, rows: [row] });
  }
  const list = [...groups.values()];
  list.sort((a, b) => (a.key === "none" ? 1 : b.key === "none" ? -1 : a.label.localeCompare(b.label)));
  for (const g of list) g.rows.sort((a, b) => (a.segments[0]?.startAt ?? "").localeCompare(b.segments[0]?.startAt ?? ""));
  return list;
}
