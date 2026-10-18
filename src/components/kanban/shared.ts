/**
 * Server-safe helpers for the Board (docs/SIMPLIFICATION-PLAN.md §8 follow-up: the five stage
 * columns). Shared by the page and the client board, so the column words, tones and the plain
 * "why not" reasons for a refused drop live in one place.
 */
import { STAGE_TONE_CLASSES } from "@/lib/constants";
import { STAGE_META, STAGE_TABS, type Stage } from "@/lib/stages";
import type { StageBoardCard, StageBoardMoveAction } from "@/lib/types";

/** A column is a stage; Cancelled is the read-only extra column behind "Show cancelled". */
export type BoardColumnKey = Stage;

/** The five droppable columns, in order. */
export const BOARD_STAGES: readonly Stage[] = STAGE_TABS;

/** URL key holding a column's expanded card limit ("Show more"). */
export function kanbanLimitKey(column: BoardColumnKey): string {
  return `more_${column}`;
}

/** The stage word of a column ("Needs editor"). */
export function columnLabel(column: BoardColumnKey): string {
  return STAGE_META[column].label;
}

/** The stage pill tone classes (pill + dot) of a column — exactly the ones `StagePill` uses. */
export function columnTone(column: BoardColumnKey): { pill: string; dot: string } {
  return STAGE_TONE_CLASSES[STAGE_META[column].tone];
}

/** The button a drop stands for, in the words of the job page. */
export const MOVE_BUTTON_LABEL: Record<StageBoardMoveAction, string> = {
  assign: "Assign editor",
  send_for_checking: "Send for checking",
  approve: "Approve",
  ask_for_changes: "Ask for changes",
  reopen: "Reopen",
};

interface BoardStep {
  from: Stage;
  to: Stage;
  action: StageBoardMoveAction;
  /** Who presses this button (for the "not you" reason). */
  who: string;
}

/** Every step the board knows, whoever the viewer is (the rule itself is `stageBoardMoves` on the server). */
const BOARD_STEPS: readonly BoardStep[] = [
  { from: "needs_editor", to: "with_editor", action: "assign", who: "the owner, or the photographer who shot it," },
  { from: "with_editor", to: "ready_to_check", action: "send_for_checking", who: "the editor who has this job" },
  { from: "changes_asked", to: "ready_to_check", action: "send_for_checking", who: "the editor who has this job" },
  { from: "ready_to_check", to: "done", action: "approve", who: "the owner, or the photographer who checks this job," },
  { from: "ready_to_check", to: "changes_asked", action: "ask_for_changes", who: "the owner, or the photographer who checks this job," },
  { from: "done", to: "changes_asked", action: "reopen", who: "the owner" },
];

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Plain words for a drop that is not one of the viewer's buttons: either someone else's step
 * ("Only the editor who has this job can send it for checking") or not a step at all
 * ("From With editor a job can only go to Ready to check (Send for checking)").
 */
export function whyNotMove(card: StageBoardCard, to: Stage): string {
  const from = card.job.stage.stage;
  if (from === "cancelled") return "Cancelled jobs are restored from the job page.";
  if (to === "cancelled") return "To cancel a job, open it and use Cancel job.";
  const step = BOARD_STEPS.find((s) => s.from === from && s.to === to);
  if (step) return `Only ${step.who} can ${lower(MOVE_BUTTON_LABEL[step.action])} here.`;
  const next = BOARD_STEPS.filter((s) => s.from === from);
  if (next.length === 0) return `Nothing moves on from ${columnLabel(from)} here.`;
  const options = [...new Map(next.map((s) => [s.to, s])).values()].map((s) => `${columnLabel(s.to)} (${MOVE_BUTTON_LABEL[s.action]})`);
  return `From ${columnLabel(from)} a job can only go to ${options.join(" or ")}.`;
}
