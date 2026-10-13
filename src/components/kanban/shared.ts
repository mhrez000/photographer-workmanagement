/** Server-safe kanban helpers (shared by the page and the client board). */
import { KANBAN_COLUMN_META, STAGE_TONE_CLASSES, type KanbanColumn } from "@/lib/constants";
import { STAGE_META, stageOf, type Stage } from "@/lib/stages";

export type BoardColumnKey = KanbanColumn | "cancelled";

/** URL key holding a column's expanded card limit ("load more"). */
export function kanbanLimitKey(column: BoardColumnKey): string {
  return `more_${column}`;
}

/** The stage a column belongs to (its first category's stage), so the board reads like the Jobs list. */
export function columnStage(column: BoardColumnKey): Stage {
  if (column === "cancelled") return "cancelled";
  return stageOf(KANBAN_COLUMN_META[column].categories[0]);
}

/**
 * A column's label split the way `StagePill` shows it: the stage word, then the
 * sub-label ("With editor" · "Not started"). Cancelled has no sub-label.
 */
export function columnLabelParts(column: BoardColumnKey): { stage: string; sub: string | null } {
  if (column === "cancelled") return { stage: STAGE_META.cancelled.label, sub: null };
  const [stage, ...rest] = KANBAN_COLUMN_META[column].label.split(" · ");
  return { stage, sub: rest.length > 0 ? rest.join(" · ") : null };
}

/** The stage pill tone classes (pill + dot) of a column — exactly the ones `StagePill` uses. */
export function columnTone(column: BoardColumnKey): { pill: string; dot: string } {
  return STAGE_TONE_CLASSES[STAGE_META[columnStage(column)].tone];
}
