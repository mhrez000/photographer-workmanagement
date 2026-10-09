/**
 * Shared job feature components. Display pieces (pills, chips, links) are
 * server-safe; action pieces are client islands that call the REST API.
 */
export { StatusPill, CategoryPill, statusColour, tintStyle, type StatusPillProps, type CategoryPillProps, type StatusLikeRef } from "./status-pill";
export { PriorityPill, type PriorityPillProps } from "./priority-pill";
export { DueChip, type DueChipProps } from "./due-chip";
export { PersonChip, PersonStack, type PersonChipProps, type PersonStackProps, type PersonRef } from "./person";
export { JobLink, jobHref, type JobLinkProps, type JobDetailTab } from "./job-link";
export { TimeInStatus, type TimeInStatusProps } from "./time-in-status";
export { RevisionCount, type RevisionCountProps } from "./revision-count";
export { LinkProviderIcon, ExternalLinkButton, resolveProvider, linkHost, type LinkProviderIconProps, type ExternalLinkButtonProps } from "./link-provider";
export { WorkloadBand, type WorkloadBandProps } from "./workload-band";
export { CapacityBar, type CapacityBarProps } from "./capacity-bar";
export { PausedChip, type PausedChipProps } from "./paused-chip";
export { RelativeTime, type RelativeTimeProps } from "./relative-time";

export { JobActionBar, planJobActions, type JobActionBarProps, type PlannedAction, type ActionPlan } from "./job-actions";
export { JobQuickActions, type JobQuickActionsProps } from "./quick-actions";
export {
  useJobActionController,
  type ActionJobSummary,
  type JobMove,
  type JobActionController,
  type JobActionControllerInput,
} from "./job-action-controller";
export { RevisionRequestDialog, type RevisionRequestDialogProps } from "./revision-request-dialog";
export { AssignEditorDialog, type AssignEditorDialogProps } from "./assign-editor-dialog";
export { ReasonDialog, type ReasonDialogProps } from "./reason-dialog";
export { ConflictDialog, type ConflictDialogProps } from "./conflict-dialog";
export { StatusPickerDialog, TransitionOverrideDialog, type StatusCandidate, type StatusPickerDialogProps, type TransitionOverrideDialogProps } from "./status-picker-dialog";
export { TimerControl, ElapsedClock, formatClock, type TimerControlProps } from "./timer-control";
export { useMutationRunner, toDialogResult, firstFieldErrors, type DialogSubmitResult, type FieldErrors, type MutationResult, type RunMutationOptions } from "./mutation";
export { useUserOptions, normaliseUserOption, type UserOption } from "./use-user-options";
