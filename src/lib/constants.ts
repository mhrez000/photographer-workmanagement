/**
 * Shared constants for the Photographer Work Management Platform.
 *
 * This file is the single source of truth for every enum-like value used by
 * `src/db/schema.ts`, the Zod schemas, the permission policy and the UI.
 * `docs/ARCHITECTURE.md` documents the meaning of each value. Keep the two in
 * sync: if you add a value here, document it there.
 *
 * Pure module: no imports from the DB or React.
 */

/* ------------------------------------------------------------------ */
/*  Roles                                                              */
/* ------------------------------------------------------------------ */

export const ROLES = ["owner", "manager", "photographer", "editor"] as const;
export type Role = (typeof ROLES)[number];

export const MANAGEMENT_ROLES: readonly Role[] = ["owner", "manager"];
export const ASSIGNMENT_ROLES = ["photographer", "editor"] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  manager: "Manager",
  photographer: "Photographer",
  editor: "Editor",
};

/* ------------------------------------------------------------------ */
/*  Status categories (semantic keys every workflow status maps to)    */
/* ------------------------------------------------------------------ */

export const STATUS_CATEGORIES = [
  "new",
  "ready",
  "assigned",
  "accepted",
  "in_progress",
  "submitted",
  "review",
  "revision",
  "resubmitted",
  "approved",
  "delivered",
  "completed",
  "cancelled",
] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

export const KANBAN_COLUMNS = ["new", "assigned", "in_progress", "review", "revision", "approved", "completed"] as const;
export type KanbanColumn = (typeof KANBAN_COLUMNS)[number];

export const KPI_BUCKETS = [
  "unassigned",
  "awaiting_editor",
  "in_editing",
  "awaiting_review",
  "revision_required",
  "approved",
  "completed",
  "none",
] as const;
export type KpiBucket = (typeof KPI_BUCKETS)[number];

export interface StatusCategoryMeta {
  /** Display label for the category itself (statuses carry their own names). */
  label: string;
  /** Tailwind colour family used for pills, columns and charts. */
  colour: string;
  /** Hex used where a literal colour is needed (charts, swatches). */
  hex: string;
  /** Kanban column this category renders in; null = hidden (cancelled). */
  kanbanColumn: KanbanColumn | null;
  /** Dashboard KPI bucket. */
  kpiBucket: KpiBucket;
  /** Counts as Active (not terminal). */
  open: boolean;
  /** Editing deadline has been met: never counted as Overdue / Due Today. */
  done: boolean;
  /** Job is held by the editor (workload + editor-held metrics). */
  editorHolds: boolean;
  /** Job is waiting on the reviewer (photographer / manager). */
  reviewerHolds: boolean;
  /** Weight applied to the workload score (waiting stages count at 25 %). */
  workloadWeight: number;
}

/**
 * The bucket map (spec §3, §9, §12, §14). Consumed by dashboard, kanban,
 * filters, workloads and bottleneck rules. Never key UI on status names.
 */
export const STATUS_CATEGORY_META: Record<StatusCategory, StatusCategoryMeta> = {
  new: { label: "New", colour: "slate", hex: "#64748b", kanbanColumn: "new", kpiBucket: "unassigned", open: true, done: false, editorHolds: false, reviewerHolds: false, workloadWeight: 0 },
  ready: { label: "Ready", colour: "sky", hex: "#0ea5e9", kanbanColumn: "new", kpiBucket: "unassigned", open: true, done: false, editorHolds: false, reviewerHolds: false, workloadWeight: 0 },
  assigned: { label: "Assigned", colour: "indigo", hex: "#6366f1", kanbanColumn: "assigned", kpiBucket: "awaiting_editor", open: true, done: false, editorHolds: true, reviewerHolds: false, workloadWeight: 1 },
  accepted: { label: "Accepted", colour: "violet", hex: "#8b5cf6", kanbanColumn: "assigned", kpiBucket: "awaiting_editor", open: true, done: false, editorHolds: true, reviewerHolds: false, workloadWeight: 1 },
  in_progress: { label: "In progress", colour: "blue", hex: "#3b82f6", kanbanColumn: "in_progress", kpiBucket: "in_editing", open: true, done: false, editorHolds: true, reviewerHolds: false, workloadWeight: 1 },
  submitted: { label: "Submitted", colour: "amber", hex: "#f59e0b", kanbanColumn: "review", kpiBucket: "awaiting_review", open: true, done: false, editorHolds: false, reviewerHolds: true, workloadWeight: 0.25 },
  review: { label: "In review", colour: "orange", hex: "#f97316", kanbanColumn: "review", kpiBucket: "awaiting_review", open: true, done: false, editorHolds: false, reviewerHolds: true, workloadWeight: 0.25 },
  revision: { label: "Revision", colour: "rose", hex: "#f43f5e", kanbanColumn: "revision", kpiBucket: "revision_required", open: true, done: false, editorHolds: true, reviewerHolds: false, workloadWeight: 1 },
  resubmitted: { label: "Resubmitted", colour: "amber", hex: "#d97706", kanbanColumn: "review", kpiBucket: "awaiting_review", open: true, done: false, editorHolds: false, reviewerHolds: true, workloadWeight: 0.25 },
  approved: { label: "Approved", colour: "emerald", hex: "#10b981", kanbanColumn: "approved", kpiBucket: "approved", open: true, done: true, editorHolds: false, reviewerHolds: false, workloadWeight: 0 },
  delivered: { label: "Delivered", colour: "teal", hex: "#14b8a6", kanbanColumn: "approved", kpiBucket: "approved", open: true, done: true, editorHolds: false, reviewerHolds: false, workloadWeight: 0 },
  completed: { label: "Completed", colour: "green", hex: "#22c55e", kanbanColumn: "completed", kpiBucket: "completed", open: false, done: true, editorHolds: false, reviewerHolds: false, workloadWeight: 0 },
  cancelled: { label: "Cancelled", colour: "zinc", hex: "#71717a", kanbanColumn: null, kpiBucket: "none", open: false, done: false, editorHolds: false, reviewerHolds: false, workloadWeight: 0 },
};

const pick = (fn: (m: StatusCategoryMeta) => boolean): readonly StatusCategory[] =>
  STATUS_CATEGORIES.filter((c) => fn(STATUS_CATEGORY_META[c]));

/** Category groups used by every KPI, filter, metric and bottleneck rule. */
export const CATEGORY_GROUPS = {
  ACTIVE: pick((m) => m.open),
  TERMINAL: pick((m) => !m.open),
  DONE: pick((m) => m.done),
  /** Active and not done: the only jobs that can be Overdue / Due Today. */
  DEADLINE_BOUND: pick((m) => m.open && !m.done),
  EDITOR_HOLDS: pick((m) => m.editorHolds),
  REVIEWER_HOLDS: pick((m) => m.reviewerHolds),
  AWAITING_EDITOR: ["assigned", "accepted"] as readonly StatusCategory[],
  UNASSIGNED: ["new", "ready"] as readonly StatusCategory[],
  IN_EDITING: ["in_progress"] as readonly StatusCategory[],
  REVISION: ["revision"] as readonly StatusCategory[],
  /** Categories whose jobs contribute to an editor's workload score. */
  WORKLOAD: pick((m) => m.workloadWeight > 0),
  /** Categories in which an editor may pause/resume and run a timer. */
  EDITOR_WORKING: ["accepted", "in_progress", "revision"] as readonly StatusCategory[],
} as const;

export const KANBAN_COLUMN_META: Record<KanbanColumn, { label: string; categories: readonly StatusCategory[] }> = {
  new: { label: "New", categories: ["new", "ready"] },
  assigned: { label: "Assigned", categories: ["assigned", "accepted"] },
  in_progress: { label: "In Progress", categories: ["in_progress"] },
  review: { label: "Review", categories: ["submitted", "review", "resubmitted"] },
  revision: { label: "Revision", categories: ["revision"] },
  approved: { label: "Approved", categories: ["approved", "delivered"] },
  completed: { label: "Completed", categories: ["completed"] },
};

/* ------------------------------------------------------------------ */
/*  Priorities                                                         */
/* ------------------------------------------------------------------ */

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_META: Record<Priority, { label: string; colour: string; hex: string; weight: number; sortOrder: number }> = {
  low: { label: "Low", colour: "slate", hex: "#94a3b8", weight: 0.8, sortOrder: 0 },
  normal: { label: "Normal", colour: "blue", hex: "#3b82f6", weight: 1, sortOrder: 1 },
  high: { label: "High", colour: "amber", hex: "#f59e0b", weight: 1.3, sortOrder: 2 },
  urgent: { label: "Urgent", colour: "red", hex: "#ef4444", weight: 1.6, sortOrder: 3 },
};

/* ------------------------------------------------------------------ */
/*  Links, notes, comments, sessions, revisions                        */
/* ------------------------------------------------------------------ */

export const LINK_KINDS = ["raw_files", "editing_workspace", "finished_files", "gallery", "client_delivery", "reference", "other"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const LINK_KIND_META: Record<LinkKind, { label: string; finishedWork: boolean }> = {
  raw_files: { label: "Raw files", finishedWork: false },
  editing_workspace: { label: "Editing workspace", finishedWork: false },
  finished_files: { label: "Finished files", finishedWork: true },
  gallery: { label: "Gallery", finishedWork: true },
  client_delivery: { label: "Client delivery", finishedWork: true },
  reference: { label: "Reference material", finishedWork: false },
  other: { label: "Other", finishedWork: false },
};

/** Link kinds an editor may add (photographers/managers may add any kind). */
export const EDITOR_LINK_KINDS: readonly LinkKind[] = ["editing_workspace", "finished_files", "gallery", "reference", "other"];

/** URL protocols accepted for external links (rejects javascript:, data:, …). */
export const ALLOWED_URL_PROTOCOLS = ["http:", "https:"] as const;

export const NOTE_KINDS = ["photographer", "editor", "internal", "revision", "client"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const NOTE_KIND_META: Record<NoteKind, { label: string; managementOnly: boolean }> = {
  photographer: { label: "Photographer notes", managementOnly: false },
  editor: { label: "Editor notes", managementOnly: false },
  internal: { label: "Internal notes", managementOnly: true },
  revision: { label: "Revision notes", managementOnly: false },
  client: { label: "Client notes", managementOnly: false },
};

export const COMMENT_KINDS = ["comment", "question", "clarification_request", "revision_response"] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

/** Minutes after posting during which the author may still edit a comment. */
export const COMMENT_EDIT_WINDOW_MINUTES = 15;

export const SESSION_END_REASONS = ["paused", "stopped", "auto_status_change", "auto_reassigned", "auto_timeout", "auto_deactivated"] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

export const REVISION_RESOLUTIONS = ["resubmitted", "withdrawn", "approved", "cancelled"] as const;
export type RevisionResolution = (typeof REVISION_RESOLUTIONS)[number];

/** Suggested chips for the free-text revision reason field. */
export const REVISION_REASON_SUGGESTIONS = ["Colour", "Retouching", "Cropping", "Missing images", "Client feedback", "Technical", "Other"] as const;

export const UNASSIGN_REASONS = ["reassigned", "unassigned", "declined", "user_deactivated", "cancelled", "reopened"] as const;
export type UnassignReason = (typeof UNASSIGN_REASONS)[number];

/* ------------------------------------------------------------------ */
/*  Activity events (audit taxonomy; see ARCHITECTURE.md §5)           */
/* ------------------------------------------------------------------ */

export const ENTITY_TYPES = [
  "job", "assignment", "transition", "comment", "revision", "note", "link", "work_session",
  "user", "team", "client", "project", "workflow", "status", "workflow_transition", "job_type",
  "automation", "automation_run", "settings", "notification", "auth", "saved_view", "dashboard",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const EVENT_ACTIONS = [
  "created", "updated", "transitioned", "assigned", "unassigned", "requested", "resolved", "withdrawn",
  "started", "paused", "resumed", "stopped", "superseded", "removed", "archived", "restored",
  "deactivated", "reactivated", "anonymised", "flagged", "mentioned", "soft_deleted", "ran",
  "logged_in", "login_failed", "logged_out", "migrated",
] as const;
export type EventAction = (typeof EVENT_ACTIONS)[number];

export const EVENT_VISIBILITIES = ["all", "management"] as const;
export type EventVisibility = (typeof EVENT_VISIBILITIES)[number];

export const EVENT_TYPES = [
  // jobs
  "job.created", "job.field_changed", "job.priority_changed", "job.due_date_changed",
  "job.review_due_date_changed", "job.delivery_due_date_changed", "job.shoot_date_changed",
  "job.status_changed", "job.accepted", "job.declined", "job.work_started", "job.paused", "job.resumed",
  "job.submitted", "job.review_started", "job.approved", "job.delivered", "job.completed",
  "job.cancelled", "job.reopened", "job.restored", "job.became_overdue", "job.review_overdue",
  "job.workflow_migrated", "job.stage_reattributed",
  // assignments
  "assignment.created", "assignment.ended",
  // revisions
  "revision.requested", "revision.resolved", "revision.withdrawn", "revision.updated",
  // comments
  "comment.added", "comment.edited", "comment.deleted", "comment.mentioned",
  // notes
  "note.added", "note.edited", "note.archived", "note.restored",
  // links
  "link.added", "link.replaced", "link.removed",
  // time tracking
  "work_session.started", "work_session.ended",
  // users / auth / teams
  "user.created", "user.updated", "user.role_changed", "user.deactivated", "user.reactivated",
  "user.password_changed", "user.capacity_changed", "user.flags_changed", "user.anonymised",
  "user.workload_band_changed", "user.notification_prefs_changed",
  "auth.logged_in", "auth.login_failed", "auth.logged_out",
  "team.created", "team.updated", "team.archived", "team.member_added", "team.member_removed",
  // clients / projects
  "client.created", "client.updated", "client.archived", "client.restored",
  "project.created", "project.updated", "project.archived", "project.restored",
  // workflow admin
  "workflow.created", "workflow.updated", "workflow.archived",
  "status.created", "status.updated", "status.archived", "status.reordered",
  "workflow_transition.created", "workflow_transition.updated", "workflow_transition.archived",
  "job_type.created", "job_type.updated", "job_type.archived",
  // automations
  "automation.created", "automation.updated", "automation.enabled", "automation.disabled", "automation.archived",
  "automation.ran",
  // settings / personalisation
  "settings.updated", "notification.sent",
  "saved_view.created", "saved_view.updated", "saved_view.deleted", "dashboard.updated",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Event types that are always written with visibility = "management". */
export const MANAGEMENT_EVENT_PREFIXES = ["user.", "auth.", "team.", "workflow.", "status.", "workflow_transition.", "job_type.", "automation.", "settings.", "notification."] as const;

/** Event types shown in the job History tab (milestones); the Activity tab shows everything. */
export const HISTORY_EVENT_TYPES: readonly EventType[] = [
  "job.created", "job.status_changed", "assignment.created", "assignment.ended", "revision.requested",
  "revision.resolved", "job.approved", "job.completed", "job.cancelled", "job.reopened", "job.restored",
  "job.due_date_changed", "job.became_overdue", "job.workflow_migrated", "job.stage_reattributed",
];

/* ------------------------------------------------------------------ */
/*  Notifications                                                      */
/* ------------------------------------------------------------------ */

export const NOTIFICATION_TYPES = [
  "job_assigned", "job_reassigned", "job_unassigned", "job_declined", "deadline_changed", "priority_changed",
  "comment_added", "mentioned", "revision_requested", "work_submitted", "work_resubmitted", "work_approved",
  "job_overdue", "review_overdue", "job_completed", "job_reopened", "job_cancelled", "job_paused",
  "workload_threshold", "editor_unavailable", "automation",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_TYPE_META: Record<NotificationType, { label: string; /** cannot be switched off in preferences */ mandatory: boolean }> = {
  job_assigned: { label: "Job assigned to me", mandatory: true },
  job_reassigned: { label: "Job reassigned", mandatory: true },
  job_unassigned: { label: "Job unassigned from me", mandatory: true },
  job_declined: { label: "Editor declined a job", mandatory: false },
  deadline_changed: { label: "Deadline changed", mandatory: false },
  priority_changed: { label: "Priority changed", mandatory: false },
  comment_added: { label: "New comment", mandatory: false },
  mentioned: { label: "I was @mentioned", mandatory: true },
  revision_requested: { label: "Revision requested", mandatory: true },
  work_submitted: { label: "Work submitted for review", mandatory: false },
  work_resubmitted: { label: "Work resubmitted", mandatory: false },
  work_approved: { label: "Work approved", mandatory: false },
  job_overdue: { label: "Job became overdue", mandatory: false },
  review_overdue: { label: "Review deadline passed", mandatory: false },
  job_completed: { label: "Job completed", mandatory: false },
  job_reopened: { label: "Job reopened", mandatory: false },
  job_cancelled: { label: "Job cancelled", mandatory: false },
  job_paused: { label: "Editor paused work", mandatory: false },
  workload_threshold: { label: "Editor workload threshold", mandatory: false },
  editor_unavailable: { label: "Editor unavailable", mandatory: false },
  automation: { label: "Automation notices", mandatory: false },
};

/* ------------------------------------------------------------------ */
/*  Automations                                                        */
/* ------------------------------------------------------------------ */

export const AUTOMATION_TRIGGER_TYPES = [
  "job_created", "status_changed", "job_assigned", "job_reassigned", "deadline_changed", "priority_changed",
  "revision_requested", "job_overdue", "workload_threshold",
] as const;
export type AutomationTriggerType = (typeof AUTOMATION_TRIGGER_TYPES)[number];

export const AUTOMATION_ACTION_TYPES = ["notify", "assign_editor", "transition", "set_priority", "add_note"] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

export const AUTOMATION_RUN_STATUSES = ["pending", "matched", "skipped", "succeeded", "failed"] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

/** Chain depth guard: an automation-caused event may trigger at most this many further levels. */
export const AUTOMATION_MAX_DEPTH = 3;

export const WORKLOAD_BANDS = ["healthy", "near_capacity", "overloaded"] as const;
export type WorkloadBand = (typeof WORKLOAD_BANDS)[number];

export const WORKLOAD_BAND_META: Record<WorkloadBand, { label: string; emoji: string; colour: string; hex: string }> = {
  healthy: { label: "Healthy", emoji: "🟢", colour: "green", hex: "#22c55e" },
  near_capacity: { label: "Near capacity", emoji: "🟡", colour: "amber", hex: "#f59e0b" },
  overloaded: { label: "Overloaded", emoji: "🔴", colour: "red", hex: "#ef4444" },
};

/**
 * Default thresholds. The organisation_settings row overrides every one of
 * them; these are the seed/column defaults and the fallback for pure helpers.
 */
export const WORKLOAD_THRESHOLDS = {
  nearCapacityRatio: 0.7,
  overloadedRatio: 1.0,
  maxActiveJobsPerEditor: 12,
  dueSoonHours: 48,
  dueSoonWeight: 1.25,
  overdueWeight: 1.5,
  defaultCapacityHoursPerWeek: 38,
  defaultEstimatedHours: 2,
} as const;

export const BOTTLENECK_DEFAULTS = {
  reviewBottleneckHours: 24,
  reviewBottleneckMinJobs: 3,
  editingBottleneckDueWithinHours: 48,
  editingBottleneckMinDueSoon: 3,
  unassignedBacklogMin: 10,
  stalledDays: 5,
  revisionSpikeMinCount: 5,
  revisionSpikeMultiplier: 1.5,
  reviewSlaHours: 24,
} as const;

export const BOTTLENECK_KINDS = ["review", "editor_overloaded", "revision_spike", "unassigned_backlog", "stalled", "editor_unavailable", "review_overdue"] as const;
export type BottleneckKind = (typeof BOTTLENECK_KINDS)[number];

/* ------------------------------------------------------------------ */
/*  Saved views / dashboards                                           */
/* ------------------------------------------------------------------ */

export const SAVED_VIEW_SCOPES = ["all_work", "my_work", "team_work", "kanban", "calendar", "timeline", "jobs", "activity"] as const;
export type SavedViewScope = (typeof SAVED_VIEW_SCOPES)[number];

export const QUICK_FILTERS = ["my_jobs", "unassigned", "overdue", "due_today", "due_this_week", "awaiting_review", "revision_required", "completed", "cancelled", "paused"] as const;
export type QuickFilter = (typeof QUICK_FILTERS)[number];

export const DASHBOARD_WIDGET_TYPES = [
  "kpis", "my_workload", "team_workload", "due_today", "overdue", "recent_activity", "editor_performance",
  "completion_rate", "revision_rate", "bottlenecks", "calendar", "recent_completed", "my_performance",
] as const;
export type DashboardWidgetType = (typeof DASHBOARD_WIDGET_TYPES)[number];

export const JOB_TABLE_COLUMNS = [
  "job", "client", "project", "photographer", "editor", "status", "priority", "created", "shootDate", "dueDate",
  "daysRemaining", "revisionCount", "lastActivity", "completionPercent", "link", "jobType", "reviewDueDate", "deliveryDueDate",
] as const;
export type JobTableColumn = (typeof JOB_TABLE_COLUMNS)[number];

/* ------------------------------------------------------------------ */
/*  Default workflow definition (seeded per organisation)              */
/* ------------------------------------------------------------------ */

export interface DefaultStatusDef {
  key: string;
  name: string;
  category: StatusCategory;
  sortOrder: number;
  colour: string;
  isInitial: boolean;
}

export const DEFAULT_WORKFLOW_NAME = "Standard Photography Workflow";

export const DEFAULT_WORKFLOW_STATUSES: readonly DefaultStatusDef[] = [
  { key: "new", name: "New", category: "new", sortOrder: 0, colour: "#64748b", isInitial: true },
  { key: "ready", name: "Ready for Assignment", category: "ready", sortOrder: 1, colour: "#0ea5e9", isInitial: false },
  { key: "assigned", name: "Assigned", category: "assigned", sortOrder: 2, colour: "#6366f1", isInitial: false },
  { key: "accepted", name: "Accepted", category: "accepted", sortOrder: 3, colour: "#8b5cf6", isInitial: false },
  { key: "in_progress", name: "In Progress", category: "in_progress", sortOrder: 4, colour: "#3b82f6", isInitial: false },
  { key: "submitted", name: "Submitted for Review", category: "submitted", sortOrder: 5, colour: "#f59e0b", isInitial: false },
  { key: "review", name: "Review Required", category: "review", sortOrder: 6, colour: "#f97316", isInitial: false },
  { key: "revision", name: "Revision Required", category: "revision", sortOrder: 7, colour: "#f43f5e", isInitial: false },
  { key: "resubmitted", name: "Resubmitted", category: "resubmitted", sortOrder: 8, colour: "#d97706", isInitial: false },
  { key: "approved", name: "Approved", category: "approved", sortOrder: 9, colour: "#10b981", isInitial: false },
  { key: "delivered", name: "Delivered", category: "delivered", sortOrder: 10, colour: "#14b8a6", isInitial: false },
  { key: "completed", name: "Completed", category: "completed", sortOrder: 11, colour: "#22c55e", isInitial: false },
  { key: "cancelled", name: "Cancelled", category: "cancelled", sortOrder: 12, colour: "#71717a", isInitial: false },
];

export interface DefaultTransitionDef {
  from: string;
  to: string;
  label: string;
  allowedRoles: readonly Role[];
  requiresAssignedEditor?: boolean;
  assigneeOnly?: boolean;
  isReopen?: boolean;
}

const OMP: readonly Role[] = ["owner", "manager", "photographer"];
const OME: readonly Role[] = ["owner", "manager", "editor"];

/**
 * Default transition table (ARCHITECTURE.md §4.2). `cancelled` is reachable
 * from every active status (rows generated by the seed for each active
 * status) and restore-from-cancelled targets the status recorded on the
 * cancel transition, so neither appears here.
 */
export const DEFAULT_WORKFLOW_TRANSITIONS: readonly DefaultTransitionDef[] = [
  { from: "new", to: "ready", label: "Mark ready", allowedRoles: OMP },
  { from: "new", to: "assigned", label: "Assign", allowedRoles: OMP, requiresAssignedEditor: true },
  { from: "ready", to: "assigned", label: "Assign", allowedRoles: OMP, requiresAssignedEditor: true },
  { from: "ready", to: "new", label: "Back to draft", allowedRoles: OMP },
  { from: "assigned", to: "accepted", label: "Accept", allowedRoles: OME, assigneeOnly: true },
  { from: "assigned", to: "in_progress", label: "Start", allowedRoles: OME, assigneeOnly: true },
  { from: "assigned", to: "ready", label: "Decline / unassign", allowedRoles: ["owner", "manager", "photographer", "editor"], assigneeOnly: true },
  { from: "accepted", to: "in_progress", label: "Start", allowedRoles: OME, assigneeOnly: true },
  { from: "accepted", to: "assigned", label: "Reassigned", allowedRoles: OMP },
  { from: "accepted", to: "ready", label: "Unassign", allowedRoles: OMP },
  { from: "in_progress", to: "submitted", label: "Submit for review", allowedRoles: OME, assigneeOnly: true },
  { from: "in_progress", to: "ready", label: "Unassign", allowedRoles: OMP },
  { from: "submitted", to: "review", label: "Begin review", allowedRoles: OMP },
  { from: "submitted", to: "revision", label: "Request revision", allowedRoles: OMP },
  { from: "submitted", to: "approved", label: "Approve", allowedRoles: OMP },
  { from: "review", to: "revision", label: "Request revision", allowedRoles: OMP },
  { from: "review", to: "approved", label: "Approve", allowedRoles: OMP },
  { from: "revision", to: "resubmitted", label: "Resubmit", allowedRoles: OME, assigneeOnly: true },
  { from: "revision", to: "ready", label: "Unassign", allowedRoles: OMP },
  { from: "resubmitted", to: "review", label: "Begin review", allowedRoles: OMP },
  { from: "resubmitted", to: "revision", label: "Request another revision", allowedRoles: OMP },
  { from: "resubmitted", to: "approved", label: "Approve", allowedRoles: OMP },
  { from: "approved", to: "delivered", label: "Deliver", allowedRoles: OMP },
  { from: "approved", to: "completed", label: "Complete", allowedRoles: OMP },
  { from: "approved", to: "revision", label: "Un-approve (late revision)", allowedRoles: OMP, requiresAssignedEditor: true },
  { from: "delivered", to: "completed", label: "Complete", allowedRoles: OMP },
  { from: "delivered", to: "revision", label: "Client bounce", allowedRoles: OMP, requiresAssignedEditor: true },
  { from: "completed", to: "revision", label: "Reopen for revision", allowedRoles: OMP, isReopen: true, requiresAssignedEditor: true },
  { from: "completed", to: "in_progress", label: "Reopen for more work", allowedRoles: OMP, isReopen: true, requiresAssignedEditor: true },
  { from: "completed", to: "approved", label: "Reopen (fix delivery)", allowedRoles: OMP, isReopen: true },
];

/** Workflow validation rules (ARCHITECTURE.md §4.6). */
export const WORKFLOW_REQUIRED_CATEGORIES: readonly StatusCategory[] = ["new", "in_progress", "submitted", "approved", "completed", "cancelled"];

/* ------------------------------------------------------------------ */
/*  Default job types                                                  */
/* ------------------------------------------------------------------ */

export const DEFAULT_JOB_TYPES: readonly { name: string; colour: string; defaultEstimatedHours: number }[] = [
  { name: "Real Estate", colour: "#0ea5e9", defaultEstimatedHours: 2 },
  { name: "Wedding", colour: "#ec4899", defaultEstimatedHours: 12 },
  { name: "Commercial", colour: "#8b5cf6", defaultEstimatedHours: 6 },
  { name: "Product", colour: "#f59e0b", defaultEstimatedHours: 3 },
  { name: "Drone", colour: "#14b8a6", defaultEstimatedHours: 1.5 },
  { name: "Twilight", colour: "#6366f1", defaultEstimatedHours: 2 },
  { name: "Video", colour: "#ef4444", defaultEstimatedHours: 10 },
  { name: "Floor Plans", colour: "#64748b", defaultEstimatedHours: 1 },
  { name: "Virtual Staging", colour: "#22c55e", defaultEstimatedHours: 2.5 },
  { name: "Retouching", colour: "#f97316", defaultEstimatedHours: 1.5 },
];

/* ------------------------------------------------------------------ */
/*  Permissions: action → roles that can EVER perform it               */
/*  Ownership / scope conditions live in src/server/auth/permissions.ts */
/* ------------------------------------------------------------------ */

/**
 * Scope legend (documented per action in ARCHITECTURE.md §3):
 *   any      — every resource in the organisation
 *   own      — job where photographerId = me or createdByUserId = me
 *   assigned — job where editorId = me (current editor)
 *   past     — job where I appear in job_assignments history (read-only)
 *   team     — job whose photographer/editor shares an active team with me (gated by org/user flags)
 *   self     — my own row / notification / view / layout
 */
export const PERMISSIONS = {
  "job.create": ["owner", "manager", "photographer"],
  "job.view": ["owner", "manager", "photographer", "editor"],
  "job.view_history": ["owner", "manager", "photographer", "editor"],
  "job.edit_fields": ["owner", "manager", "photographer"],
  "job.edit_completion_percent": ["owner", "manager", "photographer", "editor"],
  "job.set_due_date": ["owner", "manager", "photographer"],
  "job.set_review_due_date": ["owner", "manager", "photographer"],
  "job.set_delivery_due_date": ["owner", "manager", "photographer"],
  "job.set_priority": ["owner", "manager", "photographer"],
  "job.assign_photographer": ["owner", "manager", "photographer"],
  "job.assign_editor": ["owner", "manager", "photographer"],
  "job.bulk_reassign": ["owner", "manager"],
  "job.transition": ["owner", "manager", "photographer", "editor"],
  "job.transition_override": ["owner", "manager"],
  "job.accept": ["owner", "manager", "editor"],
  "job.decline": ["editor"],
  "job.start": ["owner", "manager", "editor"],
  "job.pause": ["owner", "manager", "editor"],
  "job.submit": ["owner", "manager", "editor"],
  "job.begin_review": ["owner", "manager", "photographer"],
  "job.approve": ["owner", "manager", "photographer"],
  "job.deliver": ["owner", "manager", "photographer"],
  "job.complete": ["owner", "manager", "photographer"],
  "job.cancel": ["owner", "manager", "photographer"],
  "job.reopen": ["owner", "manager", "photographer"],
  "job.restore": ["owner", "manager", "photographer"],
  "job.migrate_workflow": ["owner", "manager"],
  "revision.request": ["owner", "manager", "photographer"],
  "revision.withdraw": ["owner", "manager", "photographer"],
  "revision.resolve": ["owner", "manager", "editor"],
  "link.add": ["owner", "manager", "photographer", "editor"],
  "link.replace": ["owner", "manager", "photographer", "editor"],
  "link.remove": ["owner", "manager", "photographer", "editor"],
  "note.read": ["owner", "manager", "photographer", "editor"],
  "note.add": ["owner", "manager", "photographer", "editor"],
  "note.edit": ["owner", "manager", "photographer", "editor"],
  "note.archive": ["owner", "manager", "photographer", "editor"],
  "comment.add": ["owner", "manager", "photographer", "editor"],
  "comment.edit": ["owner", "manager", "photographer", "editor"],
  "comment.delete": ["owner", "manager", "photographer", "editor"],
  "comment.mention": ["owner", "manager", "photographer", "editor"],
  "timer.use": ["owner", "manager", "photographer", "editor"],
  "timer.view_others": ["owner", "manager", "photographer"],
  "analytics.view": ["owner", "manager", "photographer"],
  "analytics.view_self": ["owner", "manager", "photographer", "editor"],
  "workloads.view_team": ["owner", "manager", "photographer", "editor"],
  "workloads.view_self": ["owner", "manager", "photographer", "editor"],
  "performance.view": ["owner", "manager"],
  "bottlenecks.view": ["owner", "manager", "photographer"],
  "reports.view": ["owner", "manager", "photographer"],
  "export.csv": ["owner", "manager", "photographer"],
  "team.view_members": ["owner", "manager", "photographer", "editor"],
  "activity.view_global": ["owner", "manager", "photographer", "editor"],
  "activity.view_management_events": ["owner", "manager"],
  "client.view": ["owner", "manager", "photographer", "editor"],
  "client.create": ["owner", "manager", "photographer"],
  "client.edit": ["owner", "manager", "photographer"],
  "client.archive": ["owner", "manager"],
  "project.view": ["owner", "manager", "photographer", "editor"],
  "project.create": ["owner", "manager", "photographer"],
  "project.edit": ["owner", "manager", "photographer"],
  "project.archive": ["owner", "manager"],
  "user.view": ["owner", "manager", "photographer", "editor"],
  "user.invite": ["owner", "manager"],
  "user.edit": ["owner", "manager", "photographer", "editor"],
  "user.change_role": ["owner", "manager"],
  "user.deactivate": ["owner", "manager"],
  "user.reactivate": ["owner", "manager"],
  "user.set_capacity": ["owner", "manager"],
  "user.set_visibility_flags": ["owner", "manager"],
  "user.reset_password": ["owner", "manager", "photographer", "editor"],
  "user.anonymise": ["owner"],
  "team.manage": ["owner", "manager"],
  "settings.view": ["owner", "manager"],
  "settings.manage": ["owner"],
  "workflow.view": ["owner", "manager"],
  "workflow.manage": ["owner"],
  "job_type.manage": ["owner", "manager"],
  "automation.manage": ["owner", "manager"],
  "automation.view_runs": ["owner", "manager"],
  "notification.read": ["owner", "manager", "photographer", "editor"],
  "notification.prefs": ["owner", "manager", "photographer", "editor"],
  "saved_view.manage": ["owner", "manager", "photographer", "editor"],
  "saved_view.share": ["owner", "manager"],
  "dashboard.customise": ["owner", "manager", "photographer", "editor"],
  "search.global": ["owner", "manager", "photographer", "editor"],
  "system.sweep": ["owner", "manager"],
  "system.integrity": ["owner"],
} as const satisfies Record<string, readonly Role[]>;

export type Action = keyof typeof PERMISSIONS;
export const ACTIONS = Object.keys(PERMISSIONS) as readonly Action[];

/** True when the role can ever perform the action (scope conditions still apply). */
export function roleMayEver(role: Role, action: Action): boolean {
  return (PERMISSIONS[action] as readonly Role[]).includes(role);
}

/* ------------------------------------------------------------------ */
/*  Keyboard shortcuts (spec §26)                                      */
/* ------------------------------------------------------------------ */

export const KEYBOARD_SHORTCUTS: readonly { keys: string; description: string; scope: "global" | "list" | "job" }[] = [
  { keys: "mod+k", description: "Open command palette", scope: "global" },
  { keys: "/", description: "Focus search", scope: "global" },
  { keys: "?", description: "Show keyboard shortcuts", scope: "global" },
  { keys: "g d", description: "Go to Dashboard", scope: "global" },
  { keys: "g a", description: "Go to All Work", scope: "global" },
  { keys: "g m", description: "Go to My Work", scope: "global" },
  { keys: "g k", description: "Go to Kanban", scope: "global" },
  { keys: "g c", description: "Go to Calendar", scope: "global" },
  { keys: "g n", description: "Go to Notifications", scope: "global" },
  { keys: "n", description: "New job", scope: "global" },
  { keys: "j / k", description: "Move selection down / up", scope: "list" },
  { keys: "enter", description: "Open selected job", scope: "list" },
  { keys: "x", description: "Toggle selection (bulk actions)", scope: "list" },
  { keys: "f", description: "Open filters", scope: "list" },
  { keys: "c", description: "Comment on this job", scope: "job" },
  { keys: "s", description: "Start / Submit (next editor action)", scope: "job" },
  { keys: "e", description: "Edit job", scope: "job" },
  { keys: "1-8", description: "Switch job detail tab", scope: "job" },
  { keys: "esc", description: "Close dialog / clear selection", scope: "global" },
];

/* ------------------------------------------------------------------ */
/*  Misc                                                               */
/* ------------------------------------------------------------------ */

export const DEFAULT_TIMEZONE = "Australia/Sydney";
export const DEFAULT_JOB_NUMBER_PREFIX = "PJ";
export const JOB_NUMBER_PAD = 4;
export const SESSION_COOKIE_NAME = "pwm_session";
export const SESSION_TTL_DAYS = 7;
export const LOGIN_RATE_LIMIT = { attempts: 5, windowMinutes: 15 } as const;
export const SWEEP_MIN_INTERVAL_MINUTES = 5;
export const BCRYPT_COST = 12;
export const AVATAR_PALETTE = ["#6366f1", "#0ea5e9", "#14b8a6", "#22c55e", "#f59e0b", "#f97316", "#ef4444", "#ec4899", "#8b5cf6", "#64748b", "#d97706", "#0891b2"] as const;

/* ------------------------------------------------------------------ */
/*  Audit causes (activity_events.metadata.cause)                      */
/* ------------------------------------------------------------------ */

/** Why an event was written; recorded in every activity_events.metadata (ARCHITECTURE.md §5). */
export const EVENT_CAUSES = ["user", "automation", "sweep", "seed", "recompute"] as const;
export type EventCause = (typeof EVENT_CAUSES)[number];

/* ------------------------------------------------------------------ */
/*  External link providers (job_links.provider, derived from host)    */
/* ------------------------------------------------------------------ */

/** Values written to job_links.provider (see deriveLinkProvider in src/lib/validation/links.ts). */
export const LINK_PROVIDERS = ["drive", "dropbox", "onedrive", "frameio", "wetransfer", "lightroom", "pixieset", "other"] as const;
export type LinkProvider = (typeof LINK_PROVIDERS)[number];

export const LINK_PROVIDER_LABELS: Record<LinkProvider, string> = {
  drive: "Google Drive",
  dropbox: "Dropbox",
  onedrive: "OneDrive",
  frameio: "Frame.io",
  wetransfer: "WeTransfer",
  lightroom: "Lightroom",
  pixieset: "Pixieset",
  other: "Link",
};

/* ------------------------------------------------------------------ */
/*  Reports (read-side queries part 2)                                 */
/* ------------------------------------------------------------------ */

/** `GET /api/reports/:kind` kinds. */
export const REPORT_KINDS = ["production", "editors", "photographers", "business"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** Reporting range presets (mirrors `RangePreset` in src/lib/dates.ts). */
export const RANGE_PRESETS = ["today", "this_week", "this_month", "last_month", "last_7_days", "last_30_days", "custom"] as const;
