/**
 * Home for the owner / co-owners and extra photographers (docs/SIMPLIFICATION-PLAN.md §6).
 * Fixed layout, no Customise: topline · Ready to check · Needs attention · Your editors ·
 * Coming up this week. Fed by `getOwnerHome()`.
 */
export { HomeTopline, type HomeToplineProps } from "./topline";
export { ReadyToCheckSection, type ReadyToCheckSectionProps } from "./ready-to-check";
export { CheckActions, type CheckActionsProps } from "./check-actions";
export { AssignEditorAction, type AssignEditorActionProps } from "./assign-editor-action";
export { NeedsAttentionSection, type NeedsAttentionSectionProps } from "./needs-attention";
export { YourEditorsSection, type YourEditorsSectionProps } from "./your-editors";
export { ComingUpSection, type ComingUpSectionProps } from "./coming-up";
export { EmptyStudio, type EmptyStudioProps } from "./empty-studio";
export { SimplerNoticeCard, SIMPLER_NOTICE_DISMISS_PATH } from "./simpler-notice";
export { GetSetUpCard, SET_UP_STEPS, ONBOARDING_DISMISS_PATH, type GetSetUpCardProps } from "./get-set-up";
export { FirstRunHome, type FirstRunHomeProps } from "./first-run";
export { greetingAt, firstName } from "./greeting";
