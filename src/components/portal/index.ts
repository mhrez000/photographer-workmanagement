/** Client portal components (docs/ROLES.md §7.7). Clients only ever see these, never the staff shell. */
export { MilestoneStepper, type MilestoneStepperProps } from "./milestone-stepper";
export { MilestoneBadge, PortalJobCard, milestoneBadgeVariant, type PortalJobCardProps } from "./portal-job-card";
export { PortalHeader, type PortalHeaderProps } from "./portal-header";
export { PortalFeedback, type PortalFeedbackProps } from "./portal-feedback";
export { PortalNotifications, type PortalNotificationItem } from "./portal-notifications";
export { PortalNameForm, PortalNotificationPrefs, type PortalPref } from "./portal-account-forms";
export { CLIENT_LINK_LABELS, PortalDeliveryLinks, PortalDeliveryNotes } from "./portal-delivery";
export { PortalJobView, type PortalJobViewProps } from "./portal-job-view";
