/** Server-safe kanban helpers (shared by the page and the client board). */
import { KANBAN_COLUMN_META, STATUS_CATEGORY_META, type KanbanColumn } from "@/lib/constants";

export type BoardColumnKey = KanbanColumn | "cancelled";

/** URL key holding a column's expanded card limit ("load more"). */
export function kanbanLimitKey(column: BoardColumnKey): string {
  return `more_${column}`;
}

/** Accent colour of a column (its first category). */
export function columnColour(column: BoardColumnKey): string {
  if (column === "cancelled") return STATUS_CATEGORY_META.cancelled.hex;
  return STATUS_CATEGORY_META[KANBAN_COLUMN_META[column].categories[0]].hex;
}
