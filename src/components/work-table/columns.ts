/**
 * Column vocabulary for the work tables (All Work, Jobs, Team Work).
 * Pure module: safe for server and client components.
 *
 * URL contract (shared with SavedViewsBar / listJobs):
 *   ?columns=job,client,status        visible columns, in order
 *   ?sort=dueDate:desc                 one sort key (also accepts "-dueDate" and the
 *                                      pair ?sort=dueDate&dir=desc)
 *   ?groupBy=editor                    one of WORK_GROUP_BY
 */
import { JOB_TABLE_COLUMNS, type JobTableColumn } from "@/lib/constants";

export interface ColumnMeta {
  label: string;
  /** Short label for narrow headers. */
  short?: string;
  numeric?: boolean;
  /** Tailwind width / min-width classes for the cell. */
  width: string;
  sortable: boolean;
  /** Can never be hidden (the identifying column). */
  locked?: boolean;
}

export const COLUMN_META: Record<JobTableColumn, ColumnMeta> = {
  job: { label: "Job", width: "min-w-64", sortable: true, locked: true },
  client: { label: "Client", width: "min-w-36", sortable: true },
  project: { label: "Project", width: "min-w-36", sortable: true },
  photographer: { label: "Photographer", width: "min-w-36", sortable: true },
  editor: { label: "Editor", width: "min-w-36", sortable: true },
  status: { label: "Status", width: "min-w-36", sortable: true },
  priority: { label: "Priority", width: "min-w-24", sortable: true },
  created: { label: "Created", width: "min-w-24", sortable: true },
  shootDate: { label: "Shoot date", short: "Shoot", width: "min-w-24", sortable: true },
  dueDate: { label: "Due date", short: "Due", width: "min-w-28", sortable: true },
  daysRemaining: { label: "Days remaining", short: "Days left", numeric: true, width: "min-w-24", sortable: true },
  revisionCount: { label: "Revisions", short: "Rev.", numeric: true, width: "min-w-20", sortable: true },
  lastActivity: { label: "Last activity", short: "Activity", width: "min-w-28", sortable: true },
  completionPercent: { label: "Completion", short: "Done", width: "min-w-32", sortable: true },
  link: { label: "Link", width: "min-w-14", sortable: true },
  jobType: { label: "Job type", width: "min-w-32", sortable: true },
  reviewDueDate: { label: "Review due", width: "min-w-28", sortable: true },
  deliveryDueDate: { label: "Delivery due", width: "min-w-28", sortable: true },
};

/** Spec §8 column set, in spec order. */
export const DEFAULT_ALL_WORK_COLUMNS: readonly JobTableColumn[] = [
  "job",
  "client",
  "photographer",
  "editor",
  "status",
  "priority",
  "created",
  "shootDate",
  "dueDate",
  "daysRemaining",
  "revisionCount",
  "lastActivity",
  "completionPercent",
  "link",
];

/** The lighter Jobs list. */
export const JOBS_LIST_COLUMNS: readonly JobTableColumn[] = [
  "job",
  "client",
  "photographer",
  "editor",
  "status",
  "priority",
  "dueDate",
  "revisionCount",
  "lastActivity",
];

export const WORK_GROUP_BY = ["status", "editor", "photographer", "client", "priority", "jobType", "dueDate"] as const;
export type WorkGroupBy = (typeof WORK_GROUP_BY)[number];

export const GROUP_BY_LABELS: Record<WorkGroupBy, string> = {
  status: "Status",
  editor: "Editor",
  photographer: "Photographer",
  client: "Client",
  priority: "Priority",
  jobType: "Job type",
  dueDate: "Due date",
};

/**
 * Default order for the work tables when the link has no sort: workflow order
 * (new → … → completed), then soonest due. Plain due-date order would open
 * the table on months-old completed jobs.
 */
export const DEFAULT_WORK_SORT = "status:asc,dueDate:asc";

export interface SortState {
  column: JobTableColumn;
  dir: "asc" | "desc";
}

export function isJobTableColumn(value: string): value is JobTableColumn {
  return (JOB_TABLE_COLUMNS as readonly string[]).includes(value);
}

/** "a,b,c" → valid, de-duplicated columns with "job" always first; null when nothing valid. */
export function parseColumns(raw: string | null | undefined): JobTableColumn[] | null {
  if (!raw) return null;
  const seen = new Set<JobTableColumn>();
  for (const part of raw.split(",")) {
    const c = part.trim();
    if (isJobTableColumn(c)) seen.add(c);
  }
  if (seen.size === 0) return null;
  seen.delete("job");
  return ["job", ...seen];
}

/** First sort key from `?sort=` (+ optional `?dir=`). */
export function parseSort(sort: string | null | undefined, dir?: string | null): SortState | null {
  const first = sort?.split(",")[0]?.trim();
  if (!first) return null;
  const desc = first.startsWith("-");
  const [col, d] = (desc ? first.slice(1) : first).split(":");
  if (!isJobTableColumn(col)) return null;
  const direction = desc || d === "desc" || (!d && dir === "desc") ? "desc" : "asc";
  return { column: col, dir: direction };
}

export function sortParam(sort: SortState | null): string | null {
  return sort ? `${sort.column}:${sort.dir}` : null;
}

/** Header click cycle: none → asc → desc → none. */
export function nextSort(current: SortState | null, column: JobTableColumn): SortState | null {
  if (!current || current.column !== column) return { column, dir: "asc" };
  if (current.dir === "asc") return { column, dir: "desc" };
  return null;
}

export function isWorkGroupBy(value: string | null | undefined): value is WorkGroupBy {
  return !!value && (WORK_GROUP_BY as readonly string[]).includes(value);
}
