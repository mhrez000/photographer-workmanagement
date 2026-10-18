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

/**
 * Roles v2 (docs/ROLES.md §0, §1.1). Exactly three roles. "Admin" is a
 * property of a photographer (`users.is_admin`), not a role; the persona
 * (admin / member / editor / client) is derived and never stored.
 */
export const ROLES = ["photographer", "editor", "client"] as const;
export type Role = (typeof ROLES)[number];

/** Roles that use the staff app shell. */
export const STAFF_ROLES = ["photographer", "editor"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const PERSONAS = ["admin", "member", "editor", "client"] as const;
export type Persona = (typeof PERSONAS)[number];

export const PERSONA_LABELS: Record<Persona, string> = {
  admin: "Owner / Photographer",
  member: "Photographer (team member)",
  editor: "Editor",
  client: "Client",
};

/** Short names used by the Roles page columns and compact badges. */
export const PERSONA_SHORT_LABELS: Record<Persona, string> = {
  admin: "Owner",
  member: "Team member",
  editor: "Editor",
  client: "Client",
};

/** Persona of a user row (or anything shaped like one). */
export function personaOfUser(user: { role: Role; isAdmin?: boolean | null }): Persona {
  if (user.role === "photographer") return user.isAdmin ? "admin" : "member";
  return user.role;
}

/** "Owner / Photographer", "Photographer (team member)", "Editor", "Client". */
export function personaLabel(user: { role: Role; isAdmin?: boolean | null }): string {
  return PERSONA_LABELS[personaOfUser(user)];
}

/**
 * Role badge text with the optional job title: "Photographer (team member) · Studio manager"
 * (docs/ROLES.md §6.1, §11).
 */
export function displayRoleLabel(user: { role: Role; isAdmin?: boolean | null; title?: string | null }): string {
  const base = personaLabel(user);
  const title = user.title?.trim();
  // A title that only repeats the persona ("Editor · Editor", "Owner / Photographer · Owner / Photographer") adds nothing.
  if (!title || title.toLowerCase() === base.toLowerCase() || base.toLowerCase().split(" / ").includes(title.toLowerCase())) return base;
  return `${base} · ${title}`;
}

/**
 * Badge text for a person whose admin flag may not be loaded (older read models):
 * the persona label when `isAdmin` is known, else the plain role name — never
 * guesses "team member" for someone who may be the owner.
 */
export function roleBadgeLabel(user: { role: Role; isAdmin?: boolean | null }): string {
  if (user.role === "photographer" && (user.isAdmin === undefined || user.isAdmin === null)) return "Photographer";
  return personaLabel(user);
}

/**
 * @deprecated roles-v2: use `personaLabel(user)` / `PERSONA_LABELS`. Kept only so
 * not-yet-ported UI keeps rendering; it cannot tell an admin from a team member.
 */
export const ROLE_LABELS: Record<Role, string> = {
  photographer: "Photographer",
  editor: "Editor",
  client: "Client",
};

export const ASSIGNMENT_ROLES = ["photographer", "editor"] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

/** Values allowed in workflow_transitions.allowed_roles (§5). "photographer" includes admins. */
export const TRANSITION_ROLES = ["admin", "photographer", "editor"] as const;
export type TransitionRole = (typeof TRANSITION_ROLES)[number];
export const TRANSITION_ROLE_LABELS: Record<TransitionRole, string> = {
  admin: "Owner / admins (on any job)",
  photographer: "Photographers (admins, and team members on jobs they manage)",
  editor: "Editor (the assigned editor)",
};
/** Workflow editor chip text per transition role. */
export const TRANSITION_ROLE_CHIPS: Record<TransitionRole, string> = {
  admin: "Owner / admins",
  photographer: "Photographers",
  editor: "Editor",
};

/* ------------------------------------------------------------------ */
/*  Permission switches (docs/ROLES.md §2.2)                           */
/* ------------------------------------------------------------------ */

/** Team-member (non-admin photographer) switches, in the order the UI lists them. */
export const MEMBER_FLAGS = [
  "canCreateJobs",
  "canAssignEditors",
  "canReviewSubmissions",
  "canViewTeamWorkloads",
  "canViewAllJobs",
  "canViewAnalytics",
] as const;
export type MemberFlag = (typeof MEMBER_FLAGS)[number];

/** Editor switches. `canCreateJobs` is the same column as the member switch. */
export const EDITOR_FLAGS = ["canCreateJobs", "canViewTeamJobs"] as const;
export type EditorFlag = (typeof EDITOR_FLAGS)[number];

export type PermissionFlag = MemberFlag | EditorFlag;
export const PERMISSION_FLAGS = ["canCreateJobs", "canAssignEditors", "canReviewSubmissions", "canViewTeamWorkloads", "canViewAllJobs", "canViewAnalytics", "canViewTeamJobs"] as const satisfies readonly PermissionFlag[];

export interface PermissionFlagMeta {
  key: PermissionFlag;
  /** users.<column> */
  column: string;
  label: string;
  /** Plain-English description shown under the checkbox. */
  description: string;
  /** Default for a new invite. */
  inviteDefault: boolean;
  /** Default the 0003 migration gives existing users (members: v1 behaviour). */
  migratedDefault: boolean;
  /** Short tag used in the Roles page matrix ("needs: …"). */
  short: string;
}

export const MEMBER_FLAG_META: Record<MemberFlag, PermissionFlagMeta> = {
  canCreateJobs: {
    key: "canCreateJobs",
    column: "can_create_jobs",
    label: "Create jobs",
    description: "Can create jobs, clients and projects. They are the photographer on jobs they create.",
    inviteDefault: true,
    migratedDefault: true,
    short: "create",
  },
  canAssignEditors: {
    key: "canAssignEditors",
    column: "can_assign_editors",
    label: "Assign editors",
    description: "Can assign, reassign or unassign editors on their jobs.",
    inviteDefault: true,
    migratedDefault: true,
    short: "assign",
  },
  canReviewSubmissions: {
    key: "canReviewSubmissions",
    column: "can_review_submissions",
    label: "Review submissions",
    description:
      "Can approve edits, request revisions, deliver, complete and reopen their jobs, share them with the client and reply to client feedback. Also lets them cancel or re-date jobs you assigned to them.",
    inviteDefault: false,
    migratedDefault: true,
    short: "review",
  },
  canViewTeamWorkloads: {
    key: "canViewTeamWorkloads",
    column: "can_view_team_workloads",
    label: "View team workload",
    description: "Can see every editor's current workload and capacity.",
    inviteDefault: false,
    migratedDefault: false,
    short: "workloads",
  },
  canViewAllJobs: {
    key: "canViewAllJobs",
    column: "can_view_all_jobs",
    label: "See all jobs",
    description:
      "Can see every job in the business, comment on it and switch to the Whole business view. They can change only their own jobs.",
    inviteDefault: false,
    migratedDefault: false,
    short: "all",
  },
  canViewAnalytics: {
    key: "canViewAnalytics",
    column: "can_view_analytics",
    label: "See analytics and reports",
    description: "Can open Insights (analytics, bottlenecks, reports, turnaround), team performance, per-person statistics and CSV exports.",
    inviteDefault: false,
    migratedDefault: false,
    short: "analytics",
  },
};

export const EDITOR_FLAG_META: Record<EditorFlag, PermissionFlagMeta> = {
  canCreateJobs: {
    key: "canCreateJobs",
    column: "can_create_jobs",
    label: "Can add their own jobs",
    description: "Can add jobs (naming the photographer) and pick up jobs they added. Off by default (SIMPLIFICATION-PLAN §2); existing editors keep what they have.",
    inviteDefault: false,
    migratedDefault: true,
    short: "create",
  },
  canViewTeamJobs: {
    key: "canViewTeamJobs",
    column: "can_view_team_jobs",
    label: "See other editors' jobs",
    description:
      "Read-only access to jobs assigned to other editors, including your own shoots that are being edited. They still can't change them or see editors' workloads.",
    inviteDefault: false,
    migratedDefault: false,
    short: "teamJobs",
  },
};

/** The two locked "Always on" rows shown with the member switches (§2.2). */
export const MEMBER_ALWAYS_ON_ROWS: readonly { label: string; description: string }[] = [
  { label: "View their own jobs", description: "Always on: jobs they created." },
  { label: "View jobs assigned to them", description: "Always on: jobs where they are the photographer." },
];

/** Invite defaults for a new team member (review ✗ → the owner reviews their work). */
export const MEMBER_INVITE_DEFAULTS: Readonly<Record<MemberFlag, boolean>> = Object.fromEntries(
  MEMBER_FLAGS.map((f) => [f, MEMBER_FLAG_META[f].inviteDefault]),
) as Record<MemberFlag, boolean>;
export const EDITOR_INVITE_DEFAULTS: Readonly<Record<EditorFlag, boolean>> = Object.fromEntries(
  EDITOR_FLAGS.map((f) => [f, EDITOR_FLAG_META[f].inviteDefault]),
) as Record<EditorFlag, boolean>;

/* ------------------------------------------------------------------ */
/*  Personal vs business view (docs/ROLES.md §8)                       */
/* ------------------------------------------------------------------ */

export const VIEW_SCOPES = ["mine", "business"] as const;
export type ViewScope = (typeof VIEW_SCOPES)[number];
export const VIEW_SCOPE_COOKIE = "pwm_scope";
export const VIEW_SCOPE_LABELS: Record<ViewScope, string> = { mine: "My shoots", business: "Whole business" };

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

/** Categories after which the editor's work is frozen and only reviewers act (docs/ROLES.md §3.3 †, §5.2). */
export const REVIEW_GATED_CATEGORIES: readonly StatusCategory[] = [...CATEGORY_GROUPS.REVIEWER_HOLDS, "approved", "delivered", "completed"];

/** Editor creator draft window categories (docs/ROLES.md §2.1 `isEditorDraft`). */
export const DRAFT_CATEGORIES: readonly StatusCategory[] = ["new", "ready", "assigned", "accepted"];

/* ------------------------------------------------------------------ */
/*  Client portal milestones (docs/ROLES.md §7.4)                      */
/* ------------------------------------------------------------------ */

export const CLIENT_MILESTONES = ["booked", "shot", "editing", "delivered"] as const;
export type ClientMilestone = (typeof CLIENT_MILESTONES)[number];
export const CLIENT_MILESTONE_LABELS: Record<ClientMilestone, string> = {
  booked: "Booked",
  shot: "Shot",
  editing: "Editing",
  delivered: "Delivered",
};
/** Category groups the milestone mapping (`clientMilestone` in src/lib/portal.ts) keys on. */
export const CLIENT_MILESTONE_CATEGORIES = {
  /** Booked / Shot (decided by the shoot day in the org timezone). */
  preEditing: ["new", "ready", "assigned", "accepted"] as readonly StatusCategory[],
  editing: ["in_progress", "submitted", "review", "revision", "resubmitted", "approved"] as readonly StatusCategory[],
  delivered: ["delivered", "completed"] as readonly StatusCategory[],
} as const;
export const CLIENT_MILESTONE_UPDATING_LABEL = "Updating your delivery";
export const CLIENT_MILESTONE_CANCELLED_LABEL = "Cancelled";
/** A cancelled shared job stays visible in the portal (as Cancelled) for this many days. */
export const PORTAL_CANCELLED_VISIBLE_DAYS = 30;

export const KANBAN_COLUMN_META: Record<KanbanColumn, { label: string; categories: readonly StatusCategory[] }> = {
  // Labels use the five stage words (SIMPLIFICATION-PLAN §4, §8): the Board is an Advanced tool, but it
  // must read the same as the Jobs list. "With editor" and "Done" keep their sub-labels as two columns
  // so a drop still maps onto one status category.
  new: { label: "Needs editor", categories: ["new", "ready"] },
  assigned: { label: "With editor · Not started", categories: ["assigned", "accepted"] },
  in_progress: { label: "With editor · Editing", categories: ["in_progress"] },
  review: { label: "Ready to check", categories: ["submitted", "review", "resubmitted"] },
  revision: { label: "Changes asked", categories: ["revision"] },
  approved: { label: "Done · Not sent to client", categories: ["approved", "delivered"] },
  completed: { label: "Done", categories: ["completed"] },
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

/**
 * Plain-English labels (SIMPLIFICATION-PLAN §5 "Files"): the three slots the simple job page shows are
 * Raw files (photographer), Finished photos (editor) and Other links (everything else, collapsed).
 * Internal keys never change.
 */
export const LINK_KIND_META: Record<LinkKind, { label: string; finishedWork: boolean }> = {
  raw_files: { label: "Raw files", finishedWork: false },
  editing_workspace: { label: "Editing workspace", finishedWork: false },
  finished_files: { label: "Finished photos", finishedWork: true },
  gallery: { label: "Online gallery", finishedWork: true },
  client_delivery: { label: "Client download", finishedWork: true },
  reference: { label: "Reference", finishedWork: false },
  other: { label: "Other link", finishedWork: false },
};

/** The simple job page's three file slots (plan §5): which kinds fall into each. */
export const SIMPLE_LINK_SLOTS = {
  raw: ["raw_files"] as readonly LinkKind[],
  finished: ["finished_files", "gallery", "client_delivery"] as readonly LinkKind[],
  other: ["editing_workspace", "reference", "other"] as readonly LinkKind[],
} as const;

/** Link kinds an editor may add while working (photographers may add any kind; draft also allows raw_files, §3.3). */
export const EDITOR_LINK_KINDS: readonly LinkKind[] = ["editing_workspace", "finished_files", "gallery", "reference", "other"];

/** URL protocols accepted for external links (rejects javascript:, data:, …). */
export const ALLOWED_URL_PROTOCOLS = ["http:", "https:"] as const;

export const NOTE_KINDS = ["photographer", "editor", "internal", "revision", "client", "delivery"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export interface NoteKindMeta {
  label: string;
  /** Admin-only to write (and to read on jobs a member does not manage). */
  managementOnly: boolean;
  /** Shown to the client in the portal (only `delivery`). */
  clientVisible: boolean;
  /** Editors may read it on jobs they can see (§2.4: never `internal` / `client`). */
  editorReadable: boolean;
}

export const NOTE_KIND_META: Record<NoteKind, NoteKindMeta> = {
  photographer: { label: "Photographer notes", managementOnly: false, clientVisible: false, editorReadable: true },
  editor: { label: "Editor notes", managementOnly: false, clientVisible: false, editorReadable: true },
  internal: { label: "Internal notes", managementOnly: true, clientVisible: false, editorReadable: false },
  revision: { label: "Revision notes", managementOnly: false, clientVisible: false, editorReadable: true },
  /** Internal notes ABOUT the client — never shown to the client or to editors. */
  client: { label: "Client notes", managementOnly: false, clientVisible: false, editorReadable: false },
  delivery: { label: "Delivery notes (visible to the client)", managementOnly: false, clientVisible: true, editorReadable: true },
};

/** Automations can never publish client-visible text (§6.3). */
export const AUTOMATION_NOTE_KINDS = ["photographer", "editor", "internal", "revision", "client"] as const satisfies readonly NoteKind[];

export const COMMENT_KINDS = ["comment", "question", "clarification_request", "revision_response", "client_feedback"] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];
/** Comment kinds staff may start a thread with (`client_feedback` threads are started by clients, §7.5). */
export const STAFF_COMMENT_KINDS = ["comment", "question", "clarification_request", "revision_response"] as const satisfies readonly CommentKind[];
/** Kinds that count as an editor question (§6.4). */
export const QUESTION_COMMENT_KINDS = ["question", "clarification_request"] as const satisfies readonly CommentKind[];

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
  "organisation",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const EVENT_ACTIONS = [
  "created", "updated", "transitioned", "assigned", "unassigned", "requested", "resolved", "withdrawn",
  "started", "paused", "resumed", "stopped", "superseded", "removed", "archived", "restored",
  "deactivated", "reactivated", "anonymised", "flagged", "mentioned", "soft_deleted", "ran",
  "logged_in", "login_failed", "logged_out", "migrated",
  // front door (sign-up, invite links, password reset)
  "invited", "revoked",
  // job milestones (§5: the action matches the milestone name)
  "accepted", "declined", "submitted", "approved", "delivered", "completed", "cancelled", "reopened",
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
  "link.added", "link.replaced", "link.removed", "link.updated",
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
  // roles v2: sharing, portal, admin
  "job.client_sharing_changed", "project.client_sharing_changed", "link.client_sharing_changed",
  "client.portal_updated", "user.admin_changed", "settings.primary_owner_changed",
  "saved_view.created", "saved_view.updated", "saved_view.deleted", "dashboard.updated",
  // front door: sign-up, invite links, password reset (src/server/services/{organisations,invites,passwordReset}.ts)
  "org.created", "user.invite_sent", "user.invite_revoked", "user.accepted_invite", "auth.password_reset_requested",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Event types that are always written with visibility = "management". */
export const MANAGEMENT_EVENT_PREFIXES = ["user.", "auth.", "team.", "workflow.", "status.", "workflow_transition.", "job_type.", "automation.", "settings.", "notification.", "org."] as const;

/** Event types shown in the job History tab (milestones); the Activity tab shows everything. */
export const HISTORY_EVENT_TYPES: readonly EventType[] = [
  "job.created", "job.status_changed", "assignment.created", "assignment.ended", "revision.requested",
  "revision.resolved", "job.approved", "job.completed", "job.cancelled", "job.reopened", "job.restored",
  "job.due_date_changed", "job.became_overdue", "job.workflow_migrated", "job.stage_reattributed",
  // milestones the History tab links to their stage (start vs resume, decline vs unassign)
  "job.accepted", "job.declined", "job.work_started", "job.submitted", "job.review_started",
  "job.paused", "job.resumed",
];

/* ------------------------------------------------------------------ */
/*  Notifications                                                      */
/* ------------------------------------------------------------------ */

export const NOTIFICATION_TYPES = [
  "job_assigned", "job_reassigned", "job_unassigned", "job_declined", "deadline_changed", "priority_changed",
  "comment_added", "mentioned", "revision_requested", "work_submitted", "work_resubmitted", "work_approved",
  "job_overdue", "review_overdue", "job_completed", "job_reopened", "job_cancelled", "job_paused",
  "workload_threshold", "editor_unavailable", "automation",
  // roles v2 (§7.5, §7.6): staff + client types
  "client_feedback", "client_work_shared", "client_work_delivered", "client_feedback_reply",
  // roles v2 (§4.3): an editor created a job and left it without an editor
  "job_created",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface NotificationTypeMeta {
  /** Plain-English label (SIMPLIFICATION-PLAN §8 glossary). */
  label: string;
  /** Cannot be switched off in preferences. */
  mandatory: boolean;
  /**
   * Simplified defaults (plan §8 "8 notifications on by default"): with NO user_notification_prefs row,
   * `notify()` sends the type only when this is true. An explicit row always wins; mandatory types ignore
   * both. Client-portal types stay on (the portal is unchanged).
   */
  defaultOn: boolean;
  /** The plan's default group this type belongs to (null = a hidden / advanced notice). */
  group: NotificationGroup | null;
}

/** The 8 default notifications of plan §8, in the plan's order. */
export const NOTIFICATION_GROUPS = [
  "job_given",
  "ready_to_check",
  "changes_asked",
  "approved",
  "message",
  "client_feedback",
  "late_summary",
  "taken_off",
] as const;
export type NotificationGroup = (typeof NOTIFICATION_GROUPS)[number];

export const NOTIFICATION_GROUP_LABELS: Record<NotificationGroup, string> = {
  job_given: "A job was given to you",
  ready_to_check: "Ready to check",
  changes_asked: "Changes asked",
  approved: "Approved",
  message: "New message or @mention",
  client_feedback: "Client feedback",
  late_summary: "A daily \"late jobs\" summary",
  taken_off: "A job was taken off you or cancelled",
};

export const NOTIFICATION_TYPE_META: Record<NotificationType, NotificationTypeMeta> = {
  job_assigned: { label: "A job was given to you", mandatory: true, defaultOn: true, group: "job_given" },
  job_reassigned: { label: "A job was moved to another editor", mandatory: true, defaultOn: true, group: "taken_off" },
  job_unassigned: { label: "A job was taken off you", mandatory: true, defaultOn: true, group: "taken_off" },
  job_declined: { label: "An editor said \"Can't do this one\"", mandatory: false, defaultOn: false, group: null },
  deadline_changed: { label: "A due date changed", mandatory: false, defaultOn: false, group: null },
  priority_changed: { label: "A job was marked Rush (or un-marked)", mandatory: false, defaultOn: false, group: null },
  comment_added: { label: "New message on a job", mandatory: false, defaultOn: true, group: "message" },
  mentioned: { label: "You were @mentioned", mandatory: true, defaultOn: true, group: "message" },
  revision_requested: { label: "Changes asked", mandatory: true, defaultOn: true, group: "changes_asked" },
  work_submitted: { label: "Ready to check", mandatory: false, defaultOn: true, group: "ready_to_check" },
  work_resubmitted: { label: "Ready to check again (Round 2+)", mandatory: false, defaultOn: true, group: "ready_to_check" },
  work_approved: { label: "Approved", mandatory: false, defaultOn: true, group: "approved" },
  job_overdue: { label: "Late jobs (one summary a day)", mandatory: false, defaultOn: true, group: "late_summary" },
  review_overdue: { label: "A check is overdue", mandatory: false, defaultOn: false, group: null },
  job_completed: { label: "A job was closed", mandatory: false, defaultOn: false, group: null },
  job_reopened: { label: "A job was reopened", mandatory: false, defaultOn: false, group: null },
  job_cancelled: { label: "A job was cancelled", mandatory: false, defaultOn: true, group: "taken_off" },
  job_paused: { label: "An editor paused work", mandatory: false, defaultOn: false, group: null },
  workload_threshold: { label: "An editor is near capacity", mandatory: false, defaultOn: false, group: null },
  editor_unavailable: { label: "A deactivated editor still holds jobs", mandatory: false, defaultOn: false, group: null },
  automation: { label: "Automation notices", mandatory: false, defaultOn: false, group: null },
  client_feedback: { label: "Feedback from a client", mandatory: false, defaultOn: true, group: "client_feedback" },
  client_work_shared: { label: "Work shared with you", mandatory: false, defaultOn: true, group: null },
  client_work_delivered: { label: "Your work is ready", mandatory: false, defaultOn: true, group: null },
  client_feedback_reply: { label: "The studio replied", mandatory: false, defaultOn: true, group: "client_feedback" },
  job_created: { label: "An editor created a job that needs an editor", mandatory: false, defaultOn: false, group: null },
};

/** The only notification types client users receive (and staff never do). */
export const CLIENT_NOTIFICATION_TYPES = ["client_work_shared", "client_work_delivered", "client_feedback_reply"] as const satisfies readonly NotificationType[];
export type ClientNotificationType = (typeof CLIENT_NOTIFICATION_TYPES)[number];

/** Staff notification types that are ON without a preference row (the 8 groups of plan §8, 13 internal types). */
export const DEFAULT_ON_NOTIFICATION_TYPES: readonly NotificationType[] = NOTIFICATION_TYPES.filter(
  (t) => NOTIFICATION_TYPE_META[t].defaultOn && !(CLIENT_NOTIFICATION_TYPES as readonly NotificationType[]).includes(t),
);
/** Staff types hidden by default ("Mark old updates as read" targets these; still selectable in My account). */
export const DEFAULT_OFF_NOTIFICATION_TYPES: readonly NotificationType[] = NOTIFICATION_TYPES.filter(
  (t) => !NOTIFICATION_TYPE_META[t].defaultOn && !(CLIENT_NOTIFICATION_TYPES as readonly NotificationType[]).includes(t),
);
/** Types of one default group (for the My account → Notifications list). */
export function notificationTypesOfGroup(group: NotificationGroup): NotificationType[] {
  return NOTIFICATION_TYPES.filter((t) => NOTIFICATION_TYPE_META[t].group === group);
}

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
  // roles v2 (§9)
  "my_shoots", "awaiting_review", "revisions", "upcoming_deadlines", "questions", "turnaround",
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
  allowedRoles: readonly TransitionRole[];
  requiresAssignedEditor?: boolean;
  assigneeOnly?: boolean;
  isReopen?: boolean;
}

/** Reviewer-side edges: photographers (admins any job, members on jobs they manage). */
const OMP: readonly TransitionRole[] = ["photographer"];
/** Editor-side edges: the assigned editor, or an admin on their behalf. */
const OME: readonly TransitionRole[] = ["admin", "editor"];
/** Generated `→ cancelled` edges (seed, insertDefaultWorkflow, generateCancelEdges). */
export const CANCEL_EDGE_ROLES: readonly TransitionRole[] = ["photographer"];

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
  { from: "assigned", to: "ready", label: "Decline / unassign", allowedRoles: ["photographer", "editor"], assigneeOnly: true },
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

/**
 * "Usual days to edit" a fresh studio starts with per type of shoot (SIMPLIFICATION-PLAN §5: a new job's due
 * date defaults to shoot date + N). Set by `bootstrapOrganisation`; editable under Settings → Types of shoot.
 */
export const DEFAULT_USUAL_DAYS_BY_JOB_TYPE: Readonly<Record<string, number>> = {
  "Real Estate": 1,
  Drone: 1,
  Twilight: 2,
  "Floor Plans": 1,
  "Virtual Staging": 2,
  Retouching: 2,
  Product: 4,
  Commercial: 6,
  Video: 10,
  Wedding: 28,
};

/* ------------------------------------------------------------------ */
/*  Front door: sign-up, invite links, password reset                  */
/* ------------------------------------------------------------------ */

/** `auth_tokens.kind` (one-time links; the plain token is never stored). */
export const AUTH_TOKEN_KINDS = ["invite", "password_reset"] as const;
export type AuthTokenKind = (typeof AUTH_TOKEN_KINDS)[number];
/** Invite links stay valid for 7 days. */
export const INVITE_TTL_HOURS = 168;
/** Password-reset links stay valid for an hour. */
export const RESET_TTL_MINUTES = 60;
/** How a new person gets in: a link they open to set their own password (default), or a temp password read out to them. */
export const INVITE_METHODS = ["link", "temp_password"] as const;
export type InviteMethod = (typeof INVITE_METHODS)[number];
/** organisations.slug: lower-case letters, digits and single hyphens; a numeric suffix is added when taken. */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export const SLUG_MAX_LENGTH = 48;
export const SLUG_FALLBACK = "studio";
export const STUDIO_NAME_MIN_LENGTH = 2;
export const STUDIO_NAME_MAX_LENGTH = 80;

/* ------------------------------------------------------------------ */
/*  Permissions: action → personas that can EVER perform it            */
/*  Scope conditions live in src/server/auth/permissions.ts (POLICY)   */
/* ------------------------------------------------------------------ */

/**
 * docs/ROLES.md §3.3. A member/editor is listed when a switch can enable the
 * action. Scope legend (§3.2): any · managed · controls · assigned · working ·
 * past · created · draft · teamView · visible · shared (client) · self · ⚑flag.
 */
const A = "admin";
const M = "member";
const E = "editor";
const C = "client";
const STAFF_P = [A, M, E] as const;
const AM = [A, M] as const;
const AE = [A, E] as const;
const ONLY_A = [A] as const;
const ALL_P = [A, M, E, C] as const;

export const PERMISSIONS = {
  // gates
  "app.access": STAFF_P,
  "portal.access": [C],
  // jobs
  "job.create": STAFF_P,
  "job.view": STAFF_P,
  "job.view_history": STAFF_P,
  "job.edit_fields": STAFF_P,
  "job.change_client": STAFF_P,
  "job.edit_completion_percent": STAFF_P,
  "job.set_due_date": STAFF_P,
  "job.set_review_due_date": STAFF_P,
  "job.set_delivery_due_date": STAFF_P,
  "job.set_priority": STAFF_P,
  "job.assign_photographer": AE,
  "job.assign_editor": AM,
  "job.claim": [E],
  "job.bulk_reassign": ONLY_A,
  "job.transition": STAFF_P,
  "job.transition_override": ONLY_A,
  "job.accept": AE,
  "job.decline": [E],
  "job.start": AE,
  "job.pause": AE,
  "job.submit": AE,
  "job.begin_review": AM,
  "job.approve": AM,
  "job.deliver": AM,
  "job.complete": AM,
  "job.cancel": AM,
  "job.reopen": AM,
  "job.restore": AM,
  "job.migrate_workflow": ONLY_A,
  "job.share_with_client": AM,
  "revision.request": AM,
  "revision.withdraw": AM,
  "revision.resolve": AE,
  // links
  "link.add": STAFF_P,
  "link.replace": STAFF_P,
  "link.remove": STAFF_P,
  "link.share_with_client": AM,
  // notes
  "note.read": STAFF_P,
  "note.add": STAFF_P,
  "note.edit": STAFF_P,
  "note.archive": STAFF_P,
  // comments
  "comment.add": STAFF_P,
  "comment.mention": STAFF_P,
  "comment.edit": ALL_P,
  "comment.delete": ALL_P,
  "client_feedback.reply": AM,
  "client_feedback.to_revision": AM,
  // time
  "timer.use": STAFF_P,
  "timer.view_others": AM,
  // insights
  "analytics.view": AM,
  "analytics.view_self": STAFF_P,
  "workloads.view_team": AM,
  "workloads.view_self": STAFF_P,
  "performance.view": AM,
  "bottlenecks.view": AM,
  "reports.view": AM,
  "export.csv": AM,
  "team.view_members": AM,
  "activity.view_global": STAFF_P,
  "activity.view_management_events": ONLY_A,
  // clients & projects
  "client.view": STAFF_P,
  "client.create": AM,
  "client.edit": AM,
  "client.archive": ONLY_A,
  "client.manage_portal": ONLY_A,
  "project.view": STAFF_P,
  "project.create": STAFF_P,
  "project.edit": AM,
  "project.archive": ONLY_A,
  "project.share_with_client": ONLY_A,
  // users
  "user.view": STAFF_P,
  "user.invite": ONLY_A,
  "user.edit": ALL_P,
  "user.change_email": ONLY_A,
  "user.change_role": ONLY_A,
  "user.deactivate": ONLY_A,
  "user.reactivate": ONLY_A,
  "user.set_capacity": ONLY_A,
  "user.set_permissions": ONLY_A,
  "user.set_admin": ONLY_A,
  "user.reset_password": ALL_P,
  "user.anonymise": ONLY_A,
  "org.transfer_primary_owner": ONLY_A,
  // admin
  "team.manage": ONLY_A,
  "settings.view": ONLY_A,
  "settings.manage": ONLY_A,
  "workflow.view": ONLY_A,
  "workflow.manage": ONLY_A,
  "job_type.manage": ONLY_A,
  "automation.manage": ONLY_A,
  "automation.view_runs": ONLY_A,
  // personal
  "notification.read": ALL_P,
  "notification.prefs": ALL_P,
  "saved_view.manage": STAFF_P,
  "saved_view.share": ONLY_A,
  "dashboard.customise": STAFF_P,
  "search.global": STAFF_P,
  "view.business_scope": AM,
  // simplified UI (plan §8): every hidden page / API needs the org's Advanced tools switch
  "advanced.view": STAFF_P,
  // portal
  "portal.view_job": [C],
  "portal.give_feedback": [C],
  // system
  "system.sweep": ONLY_A,
  "system.integrity": ONLY_A,
} as const satisfies Record<string, readonly Persona[]>;

export type Action = keyof typeof PERMISSIONS;
export const ACTIONS = Object.keys(PERMISSIONS) as readonly Action[];

/** True when the persona can ever perform the action (scope conditions still apply). */
export function personaMayEver(persona: Persona, action: Action): boolean {
  return (PERMISSIONS[action] as readonly Persona[]).includes(persona);
}

/**
 * Self-review rule (ROLES.md §3.4, loosened by SIMPLIFICATION-PLAN §12 decision 3): these actions are
 * denied to an editor or non-admin photographer who edited the job. Owners / co-owners (`is_admin`) MAY
 * perform them on a job they edited themselves — the approve-side ones only after an explicit
 * `confirmSelfApproval` (`SELF_APPROVAL_CONFIRM_ACTIONS`), recorded in history as `selfApproved`.
 */
export const SELF_REVIEW_ACTIONS = [
  "job.begin_review",
  "job.approve",
  "job.deliver",
  "job.complete",
  "revision.request",
  "revision.withdraw",
  "client_feedback.to_revision",
] as const satisfies readonly Action[];

/** The self-review actions an admin must confirm ("You edited this yourself. Approve anyway?"). */
export const SELF_APPROVAL_CONFIRM_ACTIONS = ["job.begin_review", "job.approve", "job.deliver", "job.complete"] as const satisfies readonly Action[];

/** Actions on the primary owner only the primary owner may perform on themselves (§3.4). */
export const PRIMARY_OWNER_PROTECTED_ACTIONS = [
  "user.set_admin",
  "user.change_role",
  "user.deactivate",
  "user.change_email",
  "user.reset_password",
  "user.edit",
  "user.anonymise",
] as const satisfies readonly Action[];

/* ------------------------------------------------------------------ */
/*  Login page demo accounts (docs/ROLES.md §13)                       */
/* ------------------------------------------------------------------ */

/**
 * The four accounts the login page offers (SIMPLIFICATION-PLAN §8 demo, seed profile "small"). The same
 * four exist in the "full" fixture seed, so the box is right for either profile.
 */
export const DEMO_ACCOUNTS: readonly { email: string; shownAs: string; note: string }[] = [
  { email: "owner@studio.test", shownAs: "Owner", note: "runs the studio, shoots, checks edits" },
  { email: "photographer01@studio.test", shownAs: "Photographer", note: "only their own shoots" },
  { email: "editor01@studio.test", shownAs: "Editor", note: "edits the jobs given to them" },
  { email: "client@studio.test", shownAs: "Client", note: "Harbourline Realty portal" },
];
export const DEMO_PASSWORD = "Password123!";

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
/** Public sign-up: 5 studios per hour per IP (per email when no client IP is known, see src/server/auth/rate-limit.ts). */
export const SIGNUP_RATE_LIMIT = { attempts: 5, windowMinutes: 60 } as const;
/** Forgot-password requests per email + IP. */
export const PASSWORD_RESET_RATE_LIMIT = { attempts: 5, windowMinutes: 15 } as const;
export const SWEEP_MIN_INTERVAL_MINUTES = 5;
export const BCRYPT_COST = 12;
export const AVATAR_PALETTE = ["#6366f1", "#0ea5e9", "#14b8a6", "#22c55e", "#f59e0b", "#f97316", "#ef4444", "#ec4899", "#8b5cf6", "#64748b", "#d97706", "#0891b2"] as const;

/* ------------------------------------------------------------------ */
/*  Audit causes (activity_events.metadata.cause)                      */
/* ------------------------------------------------------------------ */

/** Why an event was written; recorded in every activity_events.metadata (ARCHITECTURE.md §5). */
export const EVENT_CAUSES = ["user", "automation", "sweep", "seed", "recompute", "migration", "signup", "reset"] as const;
export type EventCause = (typeof EVENT_CAUSES)[number];

/** Business reason of a sharing event (`metadata.reason`); the cause stays the actor cause (§1.1). */
export const SHARING_REASONS = ["manual", "delivered", "client_changed", "project_client_changed"] as const;
export type SharingReason = (typeof SHARING_REASONS)[number];

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

/* ------------------------------------------------------------------ */
/*  Simplified UI (docs/SIMPLIFICATION-PLAN.md) — registries           */
/* ------------------------------------------------------------------ */

/**
 * Everything "hidden, not deleted" behind Settings → Studio → Advanced tools (plan §8). The key is what
 * `requireAdvanced` / `requireAdvancedApi` / `isAdvancedRoute` gate on; `routes` are page-path prefixes,
 * `apiPrefixes` the `/api/*` prefixes that 404 while the switch is off. Features without a page of their
 * own (pause/resume, completion %, …) list no routes: the UI simply does not render them.
 */
export const ADVANCED_FEATURES = [
  "kanban",
  "timeline",
  "analytics",
  "bottlenecks",
  "reports",
  "workloads",
  "performance",
  "workflows",
  "automations",
  "teams",
  "permissions",
  "saved_views",
  "bulk_ui",
  "projects",
  "time_tracking",
  "pause_resume",
  "completion_percent",
  "priority_levels",
  "review_due_dates",
  "extra_kinds",
  "keyboard_chords",
  "appearance_density",
] as const;
export type AdvancedFeature = (typeof ADVANCED_FEATURES)[number];

export interface AdvancedFeatureMeta {
  key: AdvancedFeature;
  label: string;
  /** Page-path prefixes this feature owns (hidden pages 404 while Advanced tools is off). */
  routes: readonly string[];
  /** `/api/*` prefixes this feature owns (404 JSON while off; internal service calls are unaffected). */
  apiPrefixes: readonly string[];
}

export const ADVANCED_FEATURE_META: Record<AdvancedFeature, AdvancedFeatureMeta> = {
  kanban: { key: "kanban", label: "Board", routes: ["/workspace/kanban"], apiPrefixes: ["/api/kanban"] },
  timeline: { key: "timeline", label: "Timeline", routes: ["/workspace/timeline"], apiPrefixes: ["/api/timeline"] },
  analytics: { key: "analytics", label: "Reports & stats", routes: ["/insights/analytics"], apiPrefixes: ["/api/analytics"] },
  bottlenecks: { key: "bottlenecks", label: "Bottlenecks", routes: ["/insights/bottlenecks"], apiPrefixes: ["/api/bottlenecks"] },
  reports: { key: "reports", label: "Reports", routes: ["/insights/reports"], apiPrefixes: ["/api/reports"] },
  workloads: { key: "workloads", label: "Workloads (capacity & bands)", routes: ["/team/workloads"], apiPrefixes: ["/api/workloads"] },
  performance: { key: "performance", label: "Performance", routes: ["/team/performance"], apiPrefixes: ["/api/performance"] },
  workflows: {
    key: "workflows",
    label: 'Workflows (custom statuses, "Move to any status")',
    routes: ["/settings/workflows"],
    apiPrefixes: ["/api/workflows", "/api/statuses", "/api/transitions"],
  },
  automations: { key: "automations", label: "Automations", routes: ["/settings/automations"], apiPrefixes: ["/api/automations", "/api/automation-runs"] },
  teams: { key: "teams", label: "Teams", routes: ["/settings/teams"], apiPrefixes: ["/api/teams"] },
  permissions: { key: "permissions", label: "Full permission table & individual switches", routes: ["/settings/roles"], apiPrefixes: ["/api/settings/permissions"] },
  saved_views: { key: "saved_views", label: "Saved views & dashboard layouts", routes: [], apiPrefixes: ["/api/views", "/api/dashboard/layout"] },
  bulk_ui: { key: "bulk_ui", label: "Group by, column chooser, bulk actions", routes: [], apiPrefixes: ["/api/jobs/bulk"] },
  projects: { key: "projects", label: "Projects page", routes: ["/projects"], apiPrefixes: [] },
  time_tracking: { key: "time_tracking", label: "Time tracking", routes: [], apiPrefixes: ["/api/me/timer"] },
  pause_resume: { key: "pause_resume", label: "Pause / resume", routes: [], apiPrefixes: [] },
  completion_percent: { key: "completion_percent", label: "Completion %", routes: [], apiPrefixes: [] },
  priority_levels: { key: "priority_levels", label: "Four priority levels (simple UI: one Rush tick)", routes: [], apiPrefixes: [] },
  review_due_dates: { key: "review_due_dates", label: "Review due and revision due dates", routes: [], apiPrefixes: [] },
  extra_kinds: { key: "extra_kinds", label: "Extra link, note and message kinds", routes: [], apiPrefixes: [] },
  keyboard_chords: { key: "keyboard_chords", label: "Keyboard chords & the shortcuts sheet", routes: [], apiPrefixes: [] },
  appearance_density: { key: "appearance_density", label: "Appearance density", routes: ["/settings/appearance"], apiPrefixes: [] },
};

/** Per-job API sub-paths that are advanced only (`/api/jobs/:id/<sub>`). */
export const ADVANCED_JOB_SUBPATHS: Readonly<Record<string, AdvancedFeature>> = {
  timer: "time_tracking",
  sessions: "time_tracking",
  pause: "pause_resume",
  resume: "pause_resume",
  "migrate-workflow": "workflows",
};

/** Simple UI priority mapping (plan §5): the single "Rush job" tick is `priority = "urgent"`, else "normal". */
export const RUSH_PRIORITY: Priority = "urgent";
export const NON_RUSH_PRIORITY: Priority = "normal";
export function priorityForRush(rush: boolean): Priority {
  return rush ? RUSH_PRIORITY : NON_RUSH_PRIORITY;
}
export function isRushPriority(priority: Priority): boolean {
  return priority === RUSH_PRIORITY;
}

/* ---------------- photographer presets (plan §2, decision 4) ---------------- */

/**
 * The six member switches become ONE choice at invite time (plan §2): "Only their own shoots" or
 * "Everything (co-owner)". A photographer whose switches match neither shows as "custom" until edited.
 * Decision 4: an extra photographer checks the edits on their own shoots (review ON); the owner can
 * always step in.
 */
export const PHOTOGRAPHER_PRESETS = ["own_shoots", "co_owner"] as const;
export type PhotographerPreset = (typeof PHOTOGRAPHER_PRESETS)[number];
export type PhotographerPresetOrCustom = PhotographerPreset | "custom";

export interface PhotographerPresetDef {
  key: PhotographerPreset;
  label: string;
  description: string;
  isAdmin: boolean;
  flags: Readonly<Record<MemberFlag, boolean>>;
}

export const PHOTOGRAPHER_PRESET_META: Record<PhotographerPreset, PhotographerPresetDef> = {
  own_shoots: {
    key: "own_shoots",
    label: "Only their own shoots",
    description: "Creates jobs for their own shoots, gives them to editors and checks the edits on those shoots. Sees only their jobs and the clients on them.",
    isAdmin: false,
    flags: {
      canCreateJobs: true,
      canAssignEditors: true,
      canReviewSubmissions: true,
      canViewAllJobs: false,
      canViewTeamWorkloads: false,
      canViewAnalytics: false,
    },
  },
  co_owner: {
    key: "co_owner",
    label: "Everything (co-owner)",
    description: "Sees and does everything the owner can, except transferring ownership.",
    isAdmin: true,
    flags: {
      canCreateJobs: true,
      canAssignEditors: true,
      canReviewSubmissions: true,
      canViewAllJobs: true,
      canViewTeamWorkloads: true,
      canViewAnalytics: true,
    },
  },
};

/** Switch values for an invite with `preset` (`isAdmin` + the six member switches). */
export function presetSwitches(preset: PhotographerPreset): { isAdmin: boolean; flags: Record<MemberFlag, boolean> } {
  const def = PHOTOGRAPHER_PRESET_META[preset];
  return { isAdmin: def.isAdmin, flags: { ...def.flags } };
}

/**
 * The preset a photographer's switches correspond to, or "custom". Admins are always "co_owner" (their
 * stored switches are ignored while `is_admin`). Editors and clients have no preset (null).
 */
export function photographerPresetOf(
  user: { role: Role; isAdmin?: boolean | null } & Partial<Record<MemberFlag, boolean | null>>,
): PhotographerPresetOrCustom | null {
  if (user.role !== "photographer") return null;
  if (user.isAdmin) return "co_owner";
  const own = PHOTOGRAPHER_PRESET_META.own_shoots.flags;
  const matches = MEMBER_FLAGS.every((f) => (user[f] ?? false) === own[f]);
  return matches ? "own_shoots" : "custom";
}

/* ---------------- silent projects (plan §5 "Projects disappear from the form") ---------------- */

/**
 * The New job form has no project field: a project is reused when the client AND the address / job name
 * match (case- and whitespace-insensitive, on the project's name or its address), else one is created from
 * the address. The portal's "grouped by property" view keeps working.
 */
export const AUTO_PROJECT_RULE = {
  matchOn: ["name", "address"] as const,
  caseInsensitive: true,
  collapseWhitespace: true,
  /** The created project's name AND address are the typed address. */
  createFrom: "address",
} as const;

/** Normalises an address / project name for the AUTO_PROJECT_RULE comparison. */
export function normaliseProjectKey(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Default "usual days to edit" of a job type with none set (plan §5: shoot date + 1). */
export const DEFAULT_USUAL_DAYS_TO_EDIT = 1;

/* ---------------- simple job actions (plan §5) ---------------- */

/** Tap-to-add chips of the "What needs changing?" box; joined they become the revision `reason`. */
export const SIMPLE_CHANGE_CHIPS = ["Sky", "Straighten", "Colour", "Remove items", "Crop", "Missing photos"] as const;
export type SimpleChangeChip = (typeof SIMPLE_CHANGE_CHIPS)[number];
/** `reason` of an Ask-for-changes request without chips. */
export const SIMPLE_CHANGES_DEFAULT_REASON = "Changes";
/** "Needed back by" defaults to tomorrow (civil days in the org timezone). */
export const SIMPLE_CHANGES_DEFAULT_DAYS = 1;

/** The one Reopen on a Done job (plan §5 ⋯ menu): two reasons. */
export const SIMPLE_REOPEN_REASONS = ["client_changes", "fix_delivery_link"] as const;
export type SimpleReopenReason = (typeof SIMPLE_REOPEN_REASONS)[number];
export const SIMPLE_REOPEN_REASON_LABELS: Record<SimpleReopenReason, string> = {
  client_changes: "Client wants changes",
  fix_delivery_link: "Fix the delivery link",
};

/** Approve (plan §12 decision 2): ask when the client uses the portal; "n/a" when they do not. */
export const APPROVE_SHARE_CHOICES = ["send", "only", "n/a"] as const;
export type ApproveShareChoice = (typeof APPROVE_SHARE_CHOICES)[number];

/** Message shown with the admin self-approval check (plan §12 decision 3). */
export const SELF_APPROVAL_CONFIRM_MESSAGE = "You edited this yourself. Approve anyway?";

/** Editors page (plan §7): below this many finished jobs the percentages read "Not enough jobs yet". */
export const MIN_JOBS_FOR_RATES = 5;

/** Daily late summary (plan §8 notification 7): one `job_overdue` notice per user per civil day. */
export function lateSummaryDedupeKey(userId: string, civilDate: string): string {
  return `late_summary:${userId}:${civilDate}`;
}
export const LATE_SUMMARY_LINK_PATH = "/jobs?late=1";

/* ---------------- stage pill tones (plan §4) ---------------- */

/**
 * The six stage colour tokens (`--stage-<tone>`, `-soft`, `-fg` in src/app/globals.css; Tailwind
 * `bg-stage-<tone>-soft` …). STAGE_META in src/lib/stages.ts names the tone per stage.
 */
export const STAGE_TONES = ["grey", "blue", "amber", "red", "green", "slate"] as const;
export type StageTone = (typeof STAGE_TONES)[number];
export const STAGE_TONE_CLASSES: Record<StageTone, { pill: string; dot: string }> = {
  grey: { pill: "bg-stage-grey-soft text-stage-grey-fg", dot: "bg-stage-grey" },
  blue: { pill: "bg-stage-blue-soft text-stage-blue-fg", dot: "bg-stage-blue" },
  amber: { pill: "bg-stage-amber-soft text-stage-amber-fg", dot: "bg-stage-amber" },
  red: { pill: "bg-stage-red-soft text-stage-red-fg", dot: "bg-stage-red" },
  green: { pill: "bg-stage-green-soft text-stage-green-fg", dot: "bg-stage-green" },
  slate: { pill: "bg-stage-slate-soft text-stage-slate-fg", dot: "bg-stage-slate" },
};

/* ---------------- seed profiles ---------------- */

/** `SEED_PROFILE`: "small" = the plan §8 demo (default); "full" = the 160-job fixture the e2e suite uses. */
export const SEED_PROFILES = ["small", "full"] as const;
export type SeedProfile = (typeof SEED_PROFILES)[number];
export const DEFAULT_SEED_PROFILE: SeedProfile = "small";
