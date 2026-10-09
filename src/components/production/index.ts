/**
 * Production structure UI (Organisation → Client → Project → Jobs, spec §23).
 * Server-safe display pieces + client islands for forms and archive.
 */
export { ProductionJobsTable, type ProductionJobsTableProps } from "./jobs-table";
export { JobsDoneBar, CountsInline, CountCell } from "./counts";
export { ProjectTimeline, StageBreakdown } from "./project-summary";
export { Highlight } from "./highlight";
export { ListPageSkeleton, DetailPageSkeleton, FormPageSkeleton } from "./skeletons";
export { ListToolbar, type ListToolbarProps } from "./list-toolbar";
export { UrlSearchInput, type UrlSearchInputProps } from "./url-search";
export { ArchiveControl, type ArchiveControlProps } from "./archive-control";
export { ClientFields, NewClientForm, EditClientDialog, EMPTY_CLIENT, type ClientFormValues, type EditClientDialogProps } from "./client-form";
export { ProjectFields, NewProjectForm, EditProjectDialog, type ProjectFormValues, type EditProjectDialogProps } from "./project-form";
export { RouteError, type RouteErrorProps } from "@/components/common/route-error";
