import type { QuickFilter } from "@/lib/constants";

/** Display labels for QUICK_FILTERS (spec §20). */
export const QUICK_FILTER_LABELS: Record<QuickFilter, string> = {
  my_jobs: "My jobs",
  unassigned: "Unassigned",
  overdue: "Overdue",
  due_today: "Due today",
  due_this_week: "Due this week",
  awaiting_review: "Awaiting review",
  revision_required: "Revision required",
  completed: "Completed",
  cancelled: "Cancelled",
  paused: "Paused",
};

/** Chip tone per quick filter (danger for overdue, attention for today…). */
export const QUICK_FILTER_TONES: Partial<Record<QuickFilter, "danger" | "attention" | "warning">> = {
  overdue: "danger",
  due_today: "attention",
  revision_required: "warning",
};

/** URL keys owned by the job FilterBar (cleared by "Clear all"). */
export const JOB_FILTER_KEYS = [
  "q",
  "quick",
  "statusCategory",
  "statusId",
  "editorId",
  "photographerId",
  "clientId",
  "projectId",
  "jobTypeId",
  "priority",
  "dueFrom",
  "dueTo",
] as const;
