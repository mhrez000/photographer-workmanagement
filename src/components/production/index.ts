/**
 * Clients UI for the simplified screens (docs/SIMPLIFICATION-PLAN.md §3 "Clients"), plus the project pieces
 * the Advanced-only Projects pages still use. Server-safe display pieces + client islands for forms.
 */
export { ProductionJobsTable, type ProductionJobsTableProps } from "./jobs-table";
export { JobsDoneBar, CountsInline, CountCell } from "./counts";
export { ProjectTimeline, StageBreakdown } from "./project-summary";
export { Highlight } from "./highlight";
export { ListPageSkeleton, DetailPageSkeleton, FormPageSkeleton } from "./skeletons";
export { ListToolbar, type ListToolbarProps } from "./list-toolbar";
export { UrlSearchInput, type UrlSearchInputProps } from "./url-search";
export { ArchiveControl, type ArchiveControlProps } from "./archive-control";
export { ClientFields, NewClientForm, NewClientDialog, EditClientDialog, EMPTY_CLIENT, clientColourFor, type ClientFormValues, type EditClientDialogProps } from "./client-form";
export { ClientJobsByAddress, groupJobsByAddress, type AddressGroup, type ClientJobsByAddressProps } from "./client-jobs";
export { ClientOnlineAccess, type ClientOnlineAccessProps, type ClientUserInvite } from "./client-online-access";
export { ClientInviteDialog, type ClientInviteDialogProps } from "./client-invite-dialog";
export { ProjectFields, NewProjectForm, EditProjectDialog, type ProjectFormValues, type EditProjectDialogProps } from "./project-form";
export { RouteError, type RouteErrorProps } from "@/components/common/route-error";
