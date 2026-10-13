/**
 * The Editors pages (docs/SIMPLIFICATION-PLAN.md §7): one row per editor, five plain numbers, the
 * "Waiting on you" line, and the editor page with its lists, chart and actions. Display pieces are
 * server components; the dialogs are client islands that call `/api/jobs/:id/simple/*`.
 */
export { EDITOR_NUMBERS, NOT_ENOUGH_LABEL, formatOnDesk, formatRate, previousPeriodLabel, type EditorNumberKey, type EditorNumberMeta } from "./numbers";
export { NumberLabel, type NumberLabelProps } from "./number-label";
export { PeriodSwitch, type PeriodSwitchProps } from "./period-switch";
export { WaitingOnYou, type WaitingOnYouProps } from "./waiting-on-you";
export { OnTimeNote } from "./on-time-note";
export { EditorsTable, type EditorsTableProps } from "./editors-table";
export { ExtraPhotographersTable, type ExtraPhotographersTableProps } from "./extra-photographers-table";
export { FiveNumbers, type FiveNumbersProps } from "./five-numbers";
export { OnDeskList, type OnDeskListProps } from "./on-desk-list";
export { ChangeEditorButton, type ChangeEditorButtonProps } from "./change-editor-button";
export { RecentlyFinished, type RecentlyFinishedProps } from "./recently-finished";
export { FinishedPerWeekChart, type FinishedPerWeekChartProps } from "./finished-per-week-chart";
export { EditorActions, type EditorActionsProps } from "./editor-actions";
export { MoveJobsDialog, type MoveJobsDialogProps } from "./move-jobs-dialog";
