/**
 * Drizzle schema — Photographer Work Management Platform.
 *
 * Conventions (ARCHITECTURE.md §2.1):
 *  - ids are `text` nanoid() (21 chars) generated in TS via $defaultFn
 *  - timestamps are ISO-8601 UTC `text` (`*At`); calendar deadlines
 *    (shootDate, dueDate, reviewDueDate, deliveryDueDate) are also ISO UTC
 *    instants (end-of-day in the organisation timezone)
 *  - Postgres (drizzle-orm/pg-core): booleans are boolean(), JSON is jsonb().$type<T>()
 *  - every tenant table carries organisation_id (org isolation by construction)
 *  - every FK is onDelete: "restrict" — nothing is hard-deleted
 *  - LEDGER tables (job_status_transitions, job_assignments, job_revisions,
 *    job_links, job_comments, work_sessions, automation_runs, notifications,
 *    team_memberships, activity_events) are append-only / fill-once; the
 *    PL/pgSQL triggers in drizzle/0001_guards.sql enforce that at the DB level
 *  - activity_events has NO updated_at column: rows are never updated
 *  - `rowid` (activity_events, job_assignments, automation_runs) is an
 *    identity column = insertion order. It replaces SQLite's implicit rowid
 *    for "same millisecond keeps insertion order" tie-breaks; never set it.
 *
 * Enum arrays come from src/lib/constants.ts so the DB, Zod and UI agree.
 */
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import {
  ASSIGNMENT_ROLES,
  AUTH_TOKEN_KINDS,
  AUTOMATION_RUN_STATUSES,
  COMMENT_KINDS,
  ENTITY_TYPES,
  EVENT_ACTIONS,
  EVENT_VISIBILITIES,
  LINK_KINDS,
  NOTE_KINDS,
  NOTIFICATION_TYPES,
  PRIORITIES,
  REVISION_RESOLUTIONS,
  ROLES,
  SAVED_VIEW_SCOPES,
  SESSION_END_REASONS,
  STATUS_CATEGORIES,
  UNASSIGN_REASONS,
  type AutomationTriggerType,
  type DashboardWidgetType,
  type JobTableColumn,
  type LinkKind,
  type NoteKind,
  type Priority,
  type StatusCategory,
  type TransitionRole,
  type WorkloadBand,
} from "@/lib/constants";

/* ------------------------------------------------------------------ */
/*  JSON column types                                                  */
/* ------------------------------------------------------------------ */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type AutomationTrigger =
  | { type: "job_created" }
  | { type: "status_changed"; toCategory?: StatusCategory; fromCategory?: StatusCategory; toStatusKey?: string }
  | { type: "job_assigned"; role: "editor" | "photographer" }
  | { type: "job_reassigned"; role: "editor" | "photographer" }
  | { type: "deadline_changed"; field?: "dueDate" | "reviewDueDate" | "deliveryDueDate" }
  | { type: "priority_changed"; toPriority?: Priority }
  | { type: "revision_requested" }
  | { type: "job_overdue" }
  | { type: "workload_threshold"; band: Exclude<WorkloadBand, "healthy"> };

export type AutomationCondition =
  | { field: "priority"; op: "in"; values: Priority[] }
  | { field: "statusCategory"; op: "in"; values: StatusCategory[] }
  | { field: "jobTypeId"; op: "in"; values: string[] }
  | { field: "clientId"; op: "in"; values: string[] }
  | { field: "editorId"; op: "in" | "is_null" | "is_not_null"; values?: string[] }
  | { field: "photographerId"; op: "in"; values: string[] }
  | { field: "revisionCount"; op: "gte" | "lte"; value: number }
  | { field: "isOverdue"; op: "eq"; value: boolean }
  | { field: "hasLinkKind"; op: "exists" | "missing"; kind: LinkKind };

export type AutomationAction =
  | {
      type: "notify";
      /** roles v2: "managers" / "owner" became "admins" (0003 rewrites stored rules; READ schemas still accept the legacy values). */
      target: "photographer" | "editor" | "previous_editor" | "creator" | "admins" | "user";
      userId?: string;
      message?: string;
    }
  | { type: "assign_editor"; target: "previous_editor" | "original_editor" | "user"; userId?: string }
  | { type: "transition"; toCategory: StatusCategory; reason?: string }
  | { type: "set_priority"; priority: Priority }
  | { type: "add_note"; kind: NoteKind; body: string };

export type AutomationActionResult = {
  action: AutomationAction;
  ok: boolean;
  detail?: string;
  activityEventId?: string;
};

export type SavedViewConfig = {
  /** e.g. { statusCategory: ["in_progress"], editorId: ["…"], quick: "overdue", q: "smith" } */
  filters: Record<string, string | string[] | boolean | null>;
  sort: { column: string; dir: "asc" | "desc" }[];
  groupBy?: "status" | "editor" | "photographer" | "client" | "priority" | "dueDate" | "jobType" | null;
  columns: JobTableColumn[];
  columnWidths?: Record<string, number>;
};

export type DashboardLayout = {
  widgets: {
    id: string;
    type: DashboardWidgetType;
    x: number;
    y: number;
    w: number;
    h: number;
    settings?: Record<string, Json>;
  }[];
};

/* ------------------------------------------------------------------ */
/*  Column helpers                                                     */
/* ------------------------------------------------------------------ */

const nowIso = () => new Date().toISOString();
const id = () => text("id").primaryKey().$defaultFn(() => nanoid());
const createdAt = () => text("created_at").notNull().$defaultFn(nowIso);
const updatedAt = () => text("updated_at").notNull().$defaultFn(nowIso);
const version = () => integer("version").notNull().default(1);
const orgId = () =>
  text("organisation_id")
    .notNull()
    .references(() => organisations.id, { onDelete: "restrict" });
const userRef = (name: string) => text(name).references((): AnyPgColumn => users.id, { onDelete: "restrict" });
const bool = (name: string, def = false) => boolean(name).notNull().default(def);

/* ------------------------------------------------------------------ */
/*  Organisations                                                      */
/* ------------------------------------------------------------------ */

export const organisations = pgTable(
  "organisations",
  {
    id: id(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /** Gap-free PJ-#### allocator; bumped inside the create-job transaction. */
    jobSequence: integer("job_sequence").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("organisations_slug_uq").on(t.slug)],
);

export const organisationSettings = pgTable("organisation_settings", {
  organisationId: text("organisation_id")
    .primaryKey()
    .references(() => organisations.id, { onDelete: "restrict" }),
  timezone: text("timezone").notNull().default("Australia/Sydney"),
  /** 0 = Sunday … 1 = Monday. */
  weekStartsOn: integer("week_starts_on").notNull().default(1),
  jobNumberPrefix: text("job_number_prefix").notNull().default("PJ"),
  timeTrackingEnabled: bool("time_tracking_enabled", false),
  workSessionAutoTimeoutMinutes: integer("work_session_auto_timeout_minutes").notNull().default(600),
  defaultCapacityHoursPerWeek: doublePrecision("default_capacity_hours_per_week").notNull().default(38),
  defaultEstimatedHours: doublePrecision("default_estimated_hours").notNull().default(2),
  // workload bands (score / capacity)
  workloadNearCapacityRatio: doublePrecision("workload_near_capacity_ratio").notNull().default(0.7),
  workloadOverloadedRatio: doublePrecision("workload_overloaded_ratio").notNull().default(1.0),
  maxActiveJobsPerEditor: integer("max_active_jobs_per_editor").notNull().default(12),
  // bottleneck rules
  reviewBottleneckHours: integer("review_bottleneck_hours").notNull().default(24),
  reviewBottleneckMinJobs: integer("review_bottleneck_min_jobs").notNull().default(3),
  editingBottleneckDueWithinHours: integer("editing_bottleneck_due_within_hours").notNull().default(48),
  editingBottleneckMinDueSoon: integer("editing_bottleneck_min_due_soon").notNull().default(3),
  unassignedBacklogMin: integer("unassigned_backlog_min").notNull().default(10),
  stalledDays: integer("stalled_days").notNull().default(5),
  revisionSpikeMinCount: integer("revision_spike_min_count").notNull().default(5),
  revisionSpikeMultiplier: doublePrecision("revision_spike_multiplier").notNull().default(1.5),
  /** Default review deadline = submittedAt + reviewSlaHours when none is set. */
  reviewSlaHours: integer("review_sla_hours").notNull().default(24),
  // visibility (roles v1). Replaced by per-user switches in roles v2 (docs/ROLES.md §1.2).
  /** @deprecated roles-v2: replaced by per-user flags; unused; drop in a later migration */
  photographersSeeAllJobs: bool("photographers_see_all_jobs", false),
  /** @deprecated roles-v2: replaced by per-user flags; unused; drop in a later migration */
  photographersSeeTeamJobs: bool("photographers_see_team_jobs", true),
  /** @deprecated roles-v2: replaced by per-user flags; unused; drop in a later migration */
  editorsSeeTeamJobs: bool("editors_see_team_jobs", false),
  /** @deprecated roles-v2: replaced by per-user flags; unused; drop in a later migration */
  editorsSeeTeamWorkloads: bool("editors_see_team_workloads", false),
  // roles v2
  /** The one admin other admins cannot demote/deactivate/re-role (trigger org_primary_owner, §1.3 f). */
  primaryOwnerUserId: text("primary_owner_user_id").references((): AnyPgColumn => users.id, { onDelete: "restrict" }),
  /** Photographer pre-filled on jobs editors create; null = the primary owner (§4.3). */
  defaultPhotographerUserId: text("default_photographer_user_id").references((): AnyPgColumn => users.id, { onDelete: "restrict" }),
  /** Post-migration notice on /settings/users dismissed (§1.5). */
  rolesV2NoticeDismissedAt: text("roles_v2_notice_dismissed_at"),
  // engine switches
  automationsEnabled: bool("automations_enabled", true),
  /** Write a notification.sent event for every notification (off: keeps the feed readable). */
  auditNotifications: bool("audit_notifications", false),
  lastOverdueSweepAt: text("last_overdue_sweep_at"),
  /**
   * Simplified UI (docs/SIMPLIFICATION-PLAN.md §8): Settings → Studio → Advanced tools.
   * Off = the hidden pages / APIs 404 (`requireAdvanced`). Migration 0004 turns it on for
   * studios that already rely on custom workflows or enabled automations.
   */
  advancedToolsEnabled: bool("advanced_tools_enabled", false),
  // ---- front door (sign-up, invites, first run) ----
  /** The first-run checklist on Home was dismissed by an admin (null = still shown while the studio is new). */
  onboardingDismissedAt: text("onboarding_dismissed_at"),
  /** Reserved: deliver in-app notifications by email too (the email channel ships first for invites / resets). */
  emailNotificationsEnabled: bool("email_notifications_enabled", false),
  updatedAt: updatedAt(),
  version: version(),
});

/* ------------------------------------------------------------------ */
/*  Users & teams                                                      */
/* ------------------------------------------------------------------ */

export const users = pgTable(
  "users",
  {
    id: id(),
    organisationId: orgId(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull(),
    role: text("role", { enum: ROLES }).notNull(),
    title: text("title"),
    isActive: bool("is_active", true),
    deactivatedAt: text("deactivated_at"),
    deactivatedByUserId: userRef("deactivated_by_user_id"),
    anonymisedAt: text("anonymised_at"),
    /** null → organisation_settings.defaultCapacityHoursPerWeek */
    capacityHoursPerWeek: doublePrecision("capacity_hours_per_week"),
    avatarColour: text("avatar_colour").notNull().default("#6366f1"),
    // ---- roles v2 (docs/ROLES.md §1.2, §2.2). Raw switches; AuthContext carries the EFFECTIVE values. ----
    /** Admin (owner / co-owner). Only for role = photographer (CHECK users_admin_photographer_ck). */
    isAdmin: bool("is_admin", false),
    /** Member AND editor switch. */
    canCreateJobs: bool("can_create_jobs", true),
    /** Member switch. */
    canViewAllJobs: bool("can_view_all_jobs", false),
    /** Member switch. */
    canAssignEditors: bool("can_assign_editors", true),
    /** Member switch. DDL default true (existing photographers keep v1 behaviour); new invites default false. */
    canReviewSubmissions: bool("can_review_submissions", true),
    /** Member switch. */
    canViewTeamWorkloads: bool("can_view_team_workloads", false),
    /** Member switch. */
    canViewAnalytics: bool("can_view_analytics", false),
    /** Editor switch: read-only view of every job held by an editor. */
    canViewTeamJobs: bool("can_view_team_jobs", false),
    /** Client users only (CHECK users_client_id_ck); immutable once set (trigger users_client_link). */
    clientId: text("client_id").references((): AnyPgColumn => clients.id, { onDelete: "restrict" }),
    /** Bumped on deactivate / role change / password change → every cookie invalid. */
    sessionVersion: integer("session_version").notNull().default(1),
    lastLoginAt: text("last_login_at"),
    // ---- simplified UI (docs/SIMPLIFICATION-PLAN.md §7, §6) ----
    /** Editors: "Usually handles up to N" jobs on their desk (blank = not set; replaces capacity hours in the simple UI). */
    usualCapacityJobs: integer("usual_capacity_jobs"),
    /** The one-time "Proofline got simpler" card on Home was dismissed. */
    simplerNoticeDismissedAt: text("simpler_notice_dismissed_at"),
    // ---- front door (invite links). An invited user has NO usable password until they accept. ----
    /** When the (last) invite was issued; null for the sign-up owner and pre-front-door rows. */
    invitedAt: text("invited_at"),
    /**
     * When the person set their own password (accepted an invite / signed up / got a temp password).
     * null = invite pending: `password_hash` is a random non-bcrypt string and login is refused with the
     * generic message. Migration 0005 backfills every existing user with `created_at`.
     */
    acceptedAt: text("accepted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex("users_email_uq").on(t.email),
    index("users_org_role_idx").on(t.organisationId, t.role, t.isActive),
    index("users_org_client_idx").on(t.organisationId, t.clientId),
  ],
);

export const userNotificationPrefs = pgTable(
  "user_notification_prefs",
  {
    id: id(),
    organisationId: orgId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    type: text("type", { enum: NOTIFICATION_TYPES }).notNull(),
    /** Missing row = enabled. Mandatory types ignore this (see NOTIFICATION_TYPE_META). */
    enabled: bool("enabled", true),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("user_notification_prefs_uq").on(t.userId, t.type)],
);

/**
 * Ledger: one-time links (invite acceptance, password reset). The plain token is shown / emailed ONCE and
 * only its sha256 hex is stored; `used_at` is fill-once (trigger `at_fill_once`, drizzle/0005_front_door.sql)
 * and marks a token consumed — accepted, or superseded by a newer token / revoked (see metadata on the
 * audit event). A token is live while `used_at IS NULL AND expires_at > now`.
 */
export const authTokens = pgTable(
  "auth_tokens",
  {
    id: id(),
    organisationId: orgId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: AUTH_TOKEN_KINDS }).notNull(),
    /** sha256(token) as 64 hex chars; the plain token is never stored. */
    tokenHash: text("token_hash").notNull(),
    /** The admin who issued an invite; null for self-service password resets. */
    createdByUserId: userRef("created_by_user_id"),
    expiresAt: text("expires_at").notNull(),
    /** Fill-once: consumed (accepted / reset) or superseded / revoked. */
    usedAt: text("used_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("auth_tokens_hash_uq").on(t.tokenHash),
    index("auth_tokens_user_kind_idx").on(t.userId, t.kind, t.usedAt),
    index("auth_tokens_org_idx").on(t.organisationId, t.createdAt),
  ],
);

export const teams = pgTable(
  "teams",
  {
    id: id(),
    organisationId: orgId(),
    name: text("name").notNull(),
    description: text("description"),
    leadUserId: userRef("lead_user_id"),
    archivedAt: text("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [uniqueIndex("teams_org_name_uq").on(t.organisationId, t.name)],
);

/** Ledger: left_at is fill-once. */
export const teamMemberships = pgTable(
  "team_memberships",
  {
    id: id(),
    organisationId: orgId(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    addedByUserId: userRef("added_by_user_id"),
    joinedAt: text("joined_at").notNull().$defaultFn(nowIso),
    leftAt: text("left_at"),
    removedByUserId: userRef("removed_by_user_id"),
  },
  (t) => [
    uniqueIndex("team_memberships_active_uq").on(t.teamId, t.userId).where(sql`left_at IS NULL`),
    index("team_memberships_user_idx").on(t.organisationId, t.userId, t.leftAt),
    index("team_memberships_team_idx").on(t.teamId, t.leftAt),
  ],
);

/* ------------------------------------------------------------------ */
/*  Clients & projects                                                 */
/* ------------------------------------------------------------------ */

export const clients = pgTable(
  "clients",
  {
    id: id(),
    organisationId: orgId(),
    name: text("name").notNull(),
    contactName: text("contact_name"),
    email: text("email"),
    phone: text("phone"),
    notes: text("notes"),
    colour: text("colour").notNull().default("#0ea5e9"),
    /** Client users can sign in only while true (written only by setClientPortal, §3.5). */
    portalEnabled: bool("portal_enabled", false),
    /** Client users may post feedback only while true (written only by setClientPortal). */
    feedbackEnabled: bool("feedback_enabled", false),
    createdByUserId: userRef("created_by_user_id"),
    archivedAt: text("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index("clients_org_name_idx").on(t.organisationId, t.name), index("clients_org_archived_idx").on(t.organisationId, t.archivedAt)],
);

export const projects = pgTable(
  "projects",
  {
    id: id(),
    organisationId: orgId(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    /** e.g. "123 Smith Street" */
    name: text("name").notNull(),
    address: text("address"),
    description: text("description"),
    startDate: text("start_date"),
    endDate: text("end_date"),
    /** Shares every job of the project (current and future) with the client (written only by shareProject). */
    sharedWithClient: bool("shared_with_client", false),
    createdByUserId: userRef("created_by_user_id"),
    archivedAt: text("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    index("projects_org_client_idx").on(t.organisationId, t.clientId),
    index("projects_org_name_idx").on(t.organisationId, t.name),
  ],
);

/* ------------------------------------------------------------------ */
/*  Workflows, statuses, transitions, job types                        */
/* ------------------------------------------------------------------ */

export const workflows = pgTable(
  "workflows",
  {
    id: id(),
    organisationId: orgId(),
    name: text("name").notNull(),
    description: text("description"),
    isDefault: bool("is_default", false),
    archivedAt: text("archived_at"),
    createdByUserId: userRef("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex("workflows_org_name_uq").on(t.organisationId, t.name),
    uniqueIndex("workflows_one_default_uq").on(t.organisationId).where(sql`is_default = true AND archived_at IS NULL`),
  ],
);

export const workflowStatuses = pgTable(
  "workflow_statuses",
  {
    id: id(),
    organisationId: orgId(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "restrict" }),
    /** Stable slug within the workflow (automations, saved views, seed reference it). */
    key: text("key").notNull(),
    /** Display name, admin-customisable. */
    name: text("name").notNull(),
    /** Semantic bucket: KPIs, kanban, permissions, metrics and automations key on this. */
    category: text("category", { enum: STATUS_CATEGORIES }).notNull(),
    colour: text("colour").notNull().default("#94a3b8"),
    sortOrder: integer("sort_order").notNull(),
    isInitial: bool("is_initial", false),
    description: text("description"),
    archivedAt: text("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex("workflow_statuses_key_uq").on(t.workflowId, t.key),
    uniqueIndex("workflow_statuses_name_uq").on(t.workflowId, t.name).where(sql`archived_at IS NULL`),
    uniqueIndex("workflow_statuses_initial_uq").on(t.workflowId).where(sql`is_initial = true AND archived_at IS NULL`),
    index("workflow_statuses_wf_order_idx").on(t.workflowId, t.sortOrder),
    index("workflow_statuses_org_cat_idx").on(t.organisationId, t.category),
  ],
);

export const workflowTransitions = pgTable(
  "workflow_transitions",
  {
    id: id(),
    organisationId: orgId(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "restrict" }),
    fromStatusId: text("from_status_id")
      .notNull()
      .references(() => workflowStatuses.id, { onDelete: "restrict" }),
    toStatusId: text("to_status_id")
      .notNull()
      .references(() => workflowStatuses.id, { onDelete: "restrict" }),
    /** e.g. "Submit for review" */
    label: text("label"),
    /** TransitionRole[] (roles v2, §5.1): non-empty subset of TRANSITION_ROLES. */
    allowedRoles: jsonb("allowed_roles").$type<TransitionRole[]>().notNull(),
    requiresAssignedEditor: bool("requires_assigned_editor", false),
    /** An editor may only perform it when they are the job's current editor. */
    assigneeOnly: bool("assignee_only", false),
    isReopen: bool("is_reopen", false),
    archivedAt: text("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("workflow_transitions_uq").on(t.fromStatusId, t.toStatusId),
    index("workflow_transitions_from_idx").on(t.workflowId, t.fromStatusId),
  ],
);

export const jobTypes = pgTable(
  "job_types",
  {
    id: id(),
    organisationId: orgId(),
    name: text("name").notNull(),
    colour: text("colour").notNull().default("#0ea5e9"),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "restrict" }),
    defaultEstimatedHours: doublePrecision("default_estimated_hours"),
    /** Simplified New job form: default due date = shoot date + this many days (null → DEFAULT_USUAL_DAYS_TO_EDIT). */
    usualDaysToEdit: integer("usual_days_to_edit"),
    sortOrder: integer("sort_order").notNull().default(0),
    archivedAt: text("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [uniqueIndex("job_types_org_name_uq").on(t.organisationId, t.name)],
);

/* ------------------------------------------------------------------ */
/*  Jobs (state table; pointer columns are derivable — see db:verify)  */
/* ------------------------------------------------------------------ */

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    organisationId: orgId(),
    /** PJ-0001 */
    jobNumber: text("job_number").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Denormalised copy of projects.client_id; the service keeps it in sync and a trigger enforces equality. */
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    jobTypeId: text("job_type_id")
      .notNull()
      .references(() => jobTypes.id, { onDelete: "restrict" }),
    /** Snapshot at creation; changing a job type's workflow affects new jobs only. */
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "restrict" }),
    priority: text("priority", { enum: PRIORITIES }).notNull().default("normal"),
    // ---- workflow state (written ONLY by transitionJobStatus; = open transition row) ----
    statusId: text("status_id")
      .notNull()
      .references(() => workflowStatuses.id, { onDelete: "restrict" }),
    statusCategory: text("status_category", { enum: STATUS_CATEGORIES }).notNull(),
    previousStatusId: text("previous_status_id").references(() => workflowStatuses.id, { onDelete: "restrict" }),
    statusEnteredAt: text("status_entered_at").notNull(),
    // ---- people (written ONLY by the assignment service; = open assignment per role) ----
    photographerId: userRef("photographer_id"),
    editorId: userRef("editor_id"),
    previousEditorId: userRef("previous_editor_id"),
    // ---- dates (ISO UTC instants; deadlines = end of day in org tz) ----
    shootDate: text("shoot_date"),
    /** Editing deadline. Drives Overdue / Due Today. */
    dueDate: text("due_date"),
    /** Reviewer deadline (calendar + review_overdue bottleneck/notification; never in Overdue KPI). */
    reviewDueDate: text("review_due_date"),
    /** Delivery deadline (calendar + filters only). */
    deliveryDueDate: text("delivery_due_date"),
    // ---- effort ----
    estimatedHours: doublePrecision("estimated_hours"),
    completionPercent: integer("completion_percent").notNull().default(0),
    /** Editor "pause work" (spec §2); only meaningful in EDITOR_WORKING categories. */
    isPaused: bool("is_paused", false),
    pausedAt: text("paused_at"),
    // ---- revisions ----
    revisionCount: integer("revision_count").notNull().default(0),
    openRevisionId: text("open_revision_id").references((): AnyPgColumn => jobRevisions.id, { onDelete: "restrict" }),
    // ---- milestones (rebuildable from job_status_transitions; reflect the CURRENT open terminal stage) ----
    startedAt: text("started_at"),
    firstSubmittedAt: text("first_submitted_at"),
    lastSubmittedAt: text("last_submitted_at"),
    approvedAt: text("approved_at"),
    approvedByUserId: userRef("approved_by_user_id"),
    /** dueDate in force when approvedAt was set — on-time % reads this, never the current dueDate. */
    dueDateAtApproval: text("due_date_at_approval"),
    deliveredAt: text("delivered_at"),
    completedAt: text("completed_at"),
    dueDateAtCompletion: text("due_date_at_completion"),
    /** approvedAt <= dueDateAtApproval; null when no due date or not yet approved. */
    wasOnTime: boolean("was_on_time"),
    cancelledAt: text("cancelled_at"),
    reopenedCount: integer("reopened_count").notNull().default(0),
    /** = MAX(activity_events.created_at) for the job; bumped by recordEvent() without a version bump. */
    lastActivityAt: text("last_activity_at").notNull(),
    /** Optimistic concurrency: mutations send expectedVersion → 409 on mismatch. */
    version: version(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Role of the creator AT CREATION ("photographer" | "editor"); never updated (CHECK jobs_created_by_role_ck). */
    createdByRole: text("created_by_role", { enum: ASSIGNMENT_ROLES }).notNull().default("photographer"),
    /** Shares this job with the client portal (written only by shareJob / the delivery step / client-change reset). */
    sharedWithClient: bool("shared_with_client", false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("jobs_org_number_uq").on(t.organisationId, t.jobNumber),
    index("jobs_org_cat_due_idx").on(t.organisationId, t.statusCategory, t.dueDate),
    index("jobs_org_editor_cat_idx").on(t.organisationId, t.editorId, t.statusCategory),
    index("jobs_org_photographer_cat_idx").on(t.organisationId, t.photographerId, t.statusCategory),
    index("jobs_org_status_idx").on(t.organisationId, t.statusId),
    index("jobs_org_completed_idx").on(t.organisationId, t.completedAt),
    index("jobs_org_shoot_idx").on(t.organisationId, t.shootDate),
    index("jobs_org_review_due_idx").on(t.organisationId, t.reviewDueDate),
    index("jobs_org_delivery_due_idx").on(t.organisationId, t.deliveryDueDate),
    index("jobs_org_project_idx").on(t.organisationId, t.projectId),
    index("jobs_org_client_idx").on(t.organisationId, t.clientId),
    index("jobs_org_activity_idx").on(t.organisationId, t.lastActivityAt),
    index("jobs_org_created_by_idx").on(t.organisationId, t.createdByUserId),
    index("jobs_org_created_idx").on(t.organisationId, t.createdAt),
  ],
);

/* ------------------------------------------------------------------ */
/*  Ledger: assignments                                                */
/* ------------------------------------------------------------------ */

export const jobAssignments = pgTable(
  "job_assignments",
  {
    id: id(),
    /** Insertion order (identity; replaces SQLite rowid). Never written by app code. */
    rowid: bigint("rowid", { mode: "number" }).notNull().generatedByDefaultAsIdentity(),
    organisationId: orgId(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "restrict" }),
    role: text("role", { enum: ASSIGNMENT_ROLES }).notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** null = automation / system */
    assignedByUserId: userRef("assigned_by_user_id"),
    assignedAt: text("assigned_at").notNull().$defaultFn(nowIso),
    reason: text("reason"),
    statusCategoryAtAssign: text("status_category_at_assign", { enum: STATUS_CATEGORIES }),
    /** fill-once */
    unassignedAt: text("unassigned_at"),
    unassignedByUserId: userRef("unassigned_by_user_id"),
    unassignReason: text("unassign_reason", { enum: UNASSIGN_REASONS }),
    /** The activity event that created this row (provenance). */
    activityEventId: text("activity_event_id").references((): AnyPgColumn => activityEvents.id, { onDelete: "restrict" }),
  },
  (t) => [
    uniqueIndex("job_assignments_open_uq").on(t.jobId, t.role).where(sql`unassigned_at IS NULL`),
    index("job_assignments_user_idx").on(t.organisationId, t.userId, t.role, t.unassignedAt),
    index("job_assignments_job_idx").on(t.jobId, t.assignedAt),
  ],
);

/* ------------------------------------------------------------------ */
/*  Ledger: status transitions (time-in-stage)                         */
/* ------------------------------------------------------------------ */

export const TRANSITION_KINDS = ["creation", "transition", "reattribution", "migration"] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

export const jobStatusTransitions = pgTable(
  "job_status_transitions",
  {
    id: id(),
    organisationId: orgId(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "restrict" }),
    /** 1, 2, 3 … per job; contiguous. */
    sequence: integer("sequence").notNull(),
    /**
     * creation = first row; transition = status change; reattribution =
     * same status, new editor (reassign mid-stage); migration = workflow migration.
     */
    kind: text("kind", { enum: TRANSITION_KINDS }).notNull().default("transition"),
    fromStatusId: text("from_status_id").references(() => workflowStatuses.id, { onDelete: "restrict" }),
    toStatusId: text("to_status_id")
      .notNull()
      .references(() => workflowStatuses.id, { onDelete: "restrict" }),
    /** Snapshots: survive status rename / recategorise. */
    fromCategory: text("from_category", { enum: STATUS_CATEGORIES }),
    toCategory: text("to_category", { enum: STATUS_CATEGORIES }).notNull(),
    statusName: text("status_name").notNull(),
    /** null = system (automation / sweep). */
    actorUserId: userRef("actor_user_id"),
    automationRunId: text("automation_run_id").references((): AnyPgColumn => automationRuns.id, { onDelete: "restrict" }),
    reason: text("reason"),
    isReopen: bool("is_reopen", false),
    isOverride: bool("is_override", false),
    enteredAt: text("entered_at").notNull().$defaultFn(nowIso),
    /** fill-once; NULL = current stage. */
    exitedAt: text("exited_at"),
    /** = exitedAt − enteredAt, filled with exitedAt. */
    durationSeconds: integer("duration_seconds"),
    /** Who held the job during this stage (per-editor stage metrics). */
    editorIdAtEntry: userRef("editor_id_at_entry"),
    photographerIdAtEntry: userRef("photographer_id_at_entry"),
    activityEventId: text("activity_event_id").references((): AnyPgColumn => activityEvents.id, { onDelete: "restrict" }),
  },
  (t) => [
    uniqueIndex("jst_open_uq").on(t.jobId).where(sql`exited_at IS NULL`),
    uniqueIndex("jst_seq_uq").on(t.jobId, t.sequence),
    index("jst_org_cat_entered_idx").on(t.organisationId, t.toCategory, t.enteredAt),
    index("jst_editor_cat_idx").on(t.organisationId, t.editorIdAtEntry, t.toCategory),
    index("jst_job_entered_idx").on(t.jobId, t.enteredAt),
  ],
);

/* ------------------------------------------------------------------ */
/*  Ledger: revisions                                                  */
/* ------------------------------------------------------------------ */

export const jobRevisions = pgTable(
  "job_revisions",
  {
    id: id(),
    organisationId: orgId(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "restrict" }),
    /** Revision #1, #2 … per job, never reused. */
    revisionNumber: integer("revision_number").notNull(),
    requestedByUserId: text("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Editor expected to resolve it. */
    assigneeUserId: userRef("assignee_user_id"),
    /** Free text with suggested chips (REVISION_REASON_SUGGESTIONS). */
    reason: text("reason").notNull(),
    description: text("description").notNull(),
    instructions: text("instructions"),
    priority: text("priority", { enum: PRIORITIES }).notNull().default("normal"),
    dueDate: text("due_date"),
    requestedAt: text("requested_at").notNull().$defaultFn(nowIso),
    requestTransitionId: text("request_transition_id").references(() => jobStatusTransitions.id, { onDelete: "restrict" }),
    /** fill-once (set on resubmit / withdraw / approve / cancel) */
    resolvedAt: text("resolved_at"),
    resolvedByUserId: userRef("resolved_by_user_id"),
    resolution: text("resolution", { enum: REVISION_RESOLUTIONS }),
    resolutionNote: text("resolution_note"),
    resolveTransitionId: text("resolve_transition_id").references(() => jobStatusTransitions.id, { onDelete: "restrict" }),
    activityEventId: text("activity_event_id").references((): AnyPgColumn => activityEvents.id, { onDelete: "restrict" }),
  },
  (t) => [
    uniqueIndex("job_revisions_number_uq").on(t.jobId, t.revisionNumber),
    uniqueIndex("job_revisions_open_uq").on(t.jobId).where(sql`resolved_at IS NULL`),
    index("job_revisions_org_requested_idx").on(t.organisationId, t.requestedAt),
    index("job_revisions_assignee_idx").on(t.organisationId, t.assigneeUserId, t.resolvedAt),
  ],
);

/* ------------------------------------------------------------------ */
/*  Ledger: comments (+ mentions)                                      */
/* ------------------------------------------------------------------ */

export const jobComments = pgTable(
  "job_comments",
  {
    id: id(),
    organisationId: orgId(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "restrict" }),
    parentCommentId: text("parent_comment_id").references((): AnyPgColumn => jobComments.id, { onDelete: "restrict" }),
    /** Top-level ancestor (= own id for roots) for one-query thread loading. */
    rootCommentId: text("root_comment_id").references((): AnyPgColumn => jobComments.id, { onDelete: "restrict" }),
    revisionId: text("revision_id").references(() => jobRevisions.id, { onDelete: "restrict" }),
    authorUserId: text("author_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: COMMENT_KINDS }).notNull().default("comment"),
    body: text("body").notNull(),
    /** Author may edit within COMMENT_EDIT_WINDOW_MINUTES; every edit is audited with before/after. */
    editedAt: text("edited_at"),
    editCount: integer("edit_count").notNull().default(0),
    /** Soft delete (fill-once); body retained, UI shows a placeholder. */
    deletedAt: text("deleted_at"),
    deletedByUserId: userRef("deleted_by_user_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("job_comments_job_idx").on(t.jobId, t.createdAt),
    index("job_comments_root_idx").on(t.rootCommentId, t.createdAt),
    index("job_comments_parent_idx").on(t.parentCommentId),
    index("job_comments_author_idx").on(t.organisationId, t.authorUserId),
  ],
);

export const commentMentions = pgTable(
  "comment_mentions",
  {
    id: id(),
    organisationId: orgId(),
    commentId: text("comment_id")
      .notNull()
      .references(() => jobComments.id, { onDelete: "restrict" }),
    mentionedUserId: text("mentioned_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("comment_mentions_uq").on(t.commentId, t.mentionedUserId),
    index("comment_mentions_user_idx").on(t.organisationId, t.mentionedUserId, t.createdAt),
  ],
);

/* ------------------------------------------------------------------ */
/*  Notes (editable in place; every edit audited with before/after)    */
/* ------------------------------------------------------------------ */

export const jobNotes = pgTable(
  "job_notes",
  {
    id: id(),
    organisationId: orgId(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: NOTE_KINDS }).notNull(),
    body: text("body").notNull(),
    authorUserId: text("author_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    lastEditedByUserId: userRef("last_edited_by_user_id"),
    /** Number of audited edits; the Notes tab shows "edited N times" and the history drawer reads note.edited events. */
    editCount: integer("edit_count").notNull().default(0),
    /** kind = revision → the revision this note belongs to. */
    revisionId: text("revision_id").references(() => jobRevisions.id, { onDelete: "restrict" }),
    isPinned: bool("is_pinned", false),
    archivedAt: text("archived_at"),
    archivedByUserId: userRef("archived_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index("job_notes_job_kind_idx").on(t.jobId, t.kind, t.archivedAt)],
);

/* ------------------------------------------------------------------ */
/*  Ledger: external links (supersession chain)                        */
/* ------------------------------------------------------------------ */

export const jobLinks = pgTable(
  "job_links",
  {
    id: id(),
    organisationId: orgId(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: LINK_KINDS }).notNull(),
    url: text("url").notNull(),
    label: text("label"),
    /** Derived from the host at write time: drive | dropbox | onedrive | frameio | wetransfer | lightroom | other. */
    provider: text("provider"),
    addedByUserId: text("added_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    /** The row this one replaced. */
    supersedesLinkId: text("supersedes_link_id").references((): AnyPgColumn => jobLinks.id, { onDelete: "restrict" }),
    /** fill-once on the OLD row when replaced. */
    supersededAt: text("superseded_at"),
    supersededByLinkId: text("superseded_by_link_id").references((): AnyPgColumn => jobLinks.id, { onDelete: "restrict" }),
    /** fill-once: removed without replacement. */
    removedAt: text("removed_at"),
    removedByUserId: userRef("removed_by_user_id"),
    removeReason: text("remove_reason"),
    /** The one mutable flag on a CURRENT link: visible to the client (frozen once superseded/removed by the 0003 guard). */
    sharedWithClient: bool("shared_with_client", false),
    /** The adder could link.share_with_client on the job at insert time (immutable; §7.3 default delivery set). */
    addedBySharer: bool("added_by_sharer", false),
    activityEventId: text("activity_event_id").references((): AnyPgColumn => activityEvents.id, { onDelete: "restrict" }),
  },
  (t) => [
    index("job_links_job_kind_idx").on(t.jobId, t.kind, t.supersededAt, t.removedAt),
    uniqueIndex("job_links_superseded_by_uq").on(t.supersededByLinkId).where(sql`superseded_by_link_id IS NOT NULL`),
    uniqueIndex("job_links_supersedes_uq").on(t.supersedesLinkId).where(sql`supersedes_link_id IS NOT NULL`),
  ],
);
// Current links = superseded_at IS NULL AND removed_at IS NULL.

/* ------------------------------------------------------------------ */
/*  Ledger: activity events (APPEND-ONLY; no updated_at by design)     */
/* ------------------------------------------------------------------ */

export const activityEvents = pgTable(
  "activity_events",
  {
    id: id(),
    /** Insertion order (identity; replaces SQLite rowid). Never written by app code. */
    rowid: bigint("rowid", { mode: "number" }).notNull().generatedByDefaultAsIdentity(),
    organisationId: orgId(),
    /** null = system (automation / sweep / seed). */
    actorUserId: userRef("actor_user_id"),
    automationRunId: text("automation_run_id").references((): AnyPgColumn => automationRuns.id, { onDelete: "restrict" }),
    /** null for non-job entities. */
    jobId: text("job_id").references(() => jobs.id, { onDelete: "restrict" }),
    entityType: text("entity_type", { enum: ENTITY_TYPES }).notNull(),
    entityId: text("entity_id").notNull(),
    /** Fine-grained type from EVENT_TYPES (e.g. "job.status_changed"). */
    eventType: text("event_type").notNull(),
    action: text("action", { enum: EVENT_ACTIONS }).notNull(),
    previousValue: jsonb("previous_value").$type<Json>(),
    newValue: jsonb("new_value").$type<Json>(),
    metadata: jsonb("metadata").$type<Record<string, Json>>().notNull().default(sql`'{}'::jsonb`),
    /** Frozen, actor-less sentence ("Status changed from Assigned to In Progress"); the UI prefixes the actor. */
    summary: text("summary").notNull(),
    /** management = redacted from every feed/history query for photographers and editors. */
    visibility: text("visibility", { enum: EVENT_VISIBILITIES }).notNull().default("all"),
    createdAt: createdAt(),
  },
  (t) => [
    index("activity_events_org_created_idx").on(t.organisationId, t.createdAt),
    index("activity_events_job_idx").on(t.jobId, t.createdAt),
    index("activity_events_actor_idx").on(t.organisationId, t.actorUserId, t.createdAt),
    index("activity_events_type_idx").on(t.organisationId, t.eventType, t.createdAt),
    index("activity_events_entity_idx").on(t.entityType, t.entityId),
  ],
);

/* ------------------------------------------------------------------ */
/*  Ledger: notifications (read_at fill-once)                          */
/* ------------------------------------------------------------------ */

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    organisationId: orgId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    type: text("type", { enum: NOTIFICATION_TYPES }).notNull(),
    title: text("title").notNull(),
    body: text("body"),
    jobId: text("job_id").references(() => jobs.id, { onDelete: "restrict" }),
    actorUserId: userRef("actor_user_id"),
    /** Provenance. */
    activityEventId: text("activity_event_id").references(() => activityEvents.id, { onDelete: "restrict" }),
    /** e.g. /jobs/<id>#revision-2 */
    linkPath: text("link_path").notNull(),
    /** e.g. overdue:<jobId>:<dueDate> ; workload:<editorId>:<band>:<civilDate> */
    dedupeKey: text("dedupe_key"),
    readAt: text("read_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_user_unread_idx").on(t.userId, t.readAt, t.createdAt),
    uniqueIndex("notifications_event_uq").on(t.userId, t.activityEventId, t.type).where(sql`activity_event_id IS NOT NULL`),
    uniqueIndex("notifications_dedupe_uq").on(t.userId, t.dedupeKey).where(sql`dedupe_key IS NOT NULL`),
  ],
);

/* ------------------------------------------------------------------ */
/*  Ledger: work sessions (time tracking)                              */
/* ------------------------------------------------------------------ */

export const workSessions = pgTable(
  "work_sessions",
  {
    id: id(),
    organisationId: orgId(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    statusIdAtStart: text("status_id_at_start")
      .notNull()
      .references(() => workflowStatuses.id, { onDelete: "restrict" }),
    categoryAtStart: text("category_at_start", { enum: STATUS_CATEGORIES }).notNull(),
    /** The stage row the session ran in (exact time-per-stage). */
    transitionId: text("transition_id")
      .notNull()
      .references(() => jobStatusTransitions.id, { onDelete: "restrict" }),
    startedAt: text("started_at").notNull().$defaultFn(nowIso),
    /** fill-once */
    endedAt: text("ended_at"),
    endReason: text("end_reason", { enum: SESSION_END_REASONS }),
    durationSeconds: integer("duration_seconds"),
    note: text("note"),
  },
  (t) => [
    uniqueIndex("work_sessions_open_per_user_uq").on(t.userId).where(sql`ended_at IS NULL`),
    index("work_sessions_job_idx").on(t.jobId, t.startedAt),
    index("work_sessions_user_idx").on(t.organisationId, t.userId, t.startedAt),
    index("work_sessions_transition_idx").on(t.transitionId),
  ],
);

/* ------------------------------------------------------------------ */
/*  Automations                                                        */
/* ------------------------------------------------------------------ */

export const automations = pgTable(
  "automations",
  {
    id: id(),
    organisationId: orgId(),
    name: text("name").notNull(),
    description: text("description"),
    isEnabled: bool("is_enabled", true),
    /** Indexed copy of trigger.type for cheap lookup. */
    triggerType: text("trigger_type").$type<AutomationTriggerType>().notNull(),
    trigger: jsonb("trigger").$type<AutomationTrigger>().notNull(),
    conditions: jsonb("conditions").$type<AutomationCondition[]>().notNull().default(sql`'[]'::jsonb`),
    actions: jsonb("actions").$type<AutomationAction[]>().notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    archivedAt: text("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index("automations_org_trigger_idx").on(t.organisationId, t.triggerType, t.isEnabled)],
);

/** Ledger: no delete; status/result fill-in only. */
export const automationRuns = pgTable(
  "automation_runs",
  {
    id: id(),
    /** Insertion order (identity; replaces SQLite rowid). Never written by app code. */
    rowid: bigint("rowid", { mode: "number" }).notNull().generatedByDefaultAsIdentity(),
    organisationId: orgId(),
    automationId: text("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "restrict" }),
    triggerEventId: text("trigger_event_id")
      .notNull()
      .references(() => activityEvents.id, { onDelete: "restrict" }),
    jobId: text("job_id").references(() => jobs.id, { onDelete: "restrict" }),
    /** 0 = caused by a human action; capped at AUTOMATION_MAX_DEPTH. */
    depth: integer("depth").notNull().default(0),
    status: text("status", { enum: AUTOMATION_RUN_STATUSES }).notNull().default("pending"),
    conditionsSnapshot: jsonb("conditions_snapshot").$type<AutomationCondition[]>().notNull().default(sql`'[]'::jsonb`),
    actionsPerformed: jsonb("actions_performed").$type<AutomationActionResult[]>().notNull().default(sql`'[]'::jsonb`),
    error: text("error"),
    createdAt: createdAt(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (t) => [
    uniqueIndex("automation_runs_dedupe_uq").on(t.automationId, t.triggerEventId),
    index("automation_runs_pending_idx").on(t.organisationId, t.status, t.createdAt),
    index("automation_runs_automation_idx").on(t.automationId, t.createdAt),
    index("automation_runs_job_idx").on(t.jobId, t.createdAt),
  ],
);

/* ------------------------------------------------------------------ */
/*  Saved views & dashboards                                           */
/* ------------------------------------------------------------------ */

export const savedViews = pgTable(
  "saved_views",
  {
    id: id(),
    organisationId: orgId(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    scope: text("scope", { enum: SAVED_VIEW_SCOPES }).notNull(),
    config: jsonb("config").$type<SavedViewConfig>().notNull(),
    isShared: bool("is_shared", false),
    isDefault: bool("is_default", false),
    archivedAt: text("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    index("saved_views_owner_scope_idx").on(t.ownerUserId, t.scope, t.archivedAt),
    index("saved_views_org_shared_idx").on(t.organisationId, t.isShared, t.scope),
  ],
);

export const dashboardLayouts = pgTable(
  "dashboard_layouts",
  {
    id: id(),
    organisationId: orgId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    layout: jsonb("layout").$type<DashboardLayout>().notNull(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [uniqueIndex("dashboard_layouts_user_uq").on(t.userId)],
);

/* ------------------------------------------------------------------ */
/*  Relations                                                          */
/*  Rule: whenever two tables are linked by more than one FK, every    */
/*  one()/many() pair carries a matching relationName.                 */
/* ------------------------------------------------------------------ */

export const organisationsRelations = relations(organisations, ({ one, many }) => ({
  settings: one(organisationSettings, { fields: [organisations.id], references: [organisationSettings.organisationId] }),
  users: many(users),
  teams: many(teams),
  clients: many(clients),
  projects: many(projects),
  workflows: many(workflows),
  jobTypes: many(jobTypes),
  jobs: many(jobs),
  automations: many(automations),
  activityEvents: many(activityEvents),
}));

export const organisationSettingsRelations = relations(organisationSettings, ({ one }) => ({
  organisation: one(organisations, { fields: [organisationSettings.organisationId], references: [organisations.id] }),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  organisation: one(organisations, { fields: [users.organisationId], references: [organisations.id] }),
  deactivatedBy: one(users, { fields: [users.deactivatedByUserId], references: [users.id], relationName: "userDeactivatedBy" }),
  notificationPrefs: many(userNotificationPrefs),
  teamMemberships: many(teamMemberships, { relationName: "membershipUser" }),
  jobsAsPhotographer: many(jobs, { relationName: "jobPhotographer" }),
  jobsAsEditor: many(jobs, { relationName: "jobEditor" }),
  jobsCreated: many(jobs, { relationName: "jobCreator" }),
  assignments: many(jobAssignments, { relationName: "assignmentUser" }),
  stagesHeld: many(jobStatusTransitions, { relationName: "transitionEditorAtEntry" }),
  comments: many(jobComments, { relationName: "commentAuthor" }),
  mentions: many(commentMentions, { relationName: "mentionedUser" }),
  notes: many(jobNotes, { relationName: "noteAuthor" }),
  links: many(jobLinks, { relationName: "linkAddedBy" }),
  revisionsRequested: many(jobRevisions, { relationName: "revisionRequester" }),
  revisionsAssigned: many(jobRevisions, { relationName: "revisionAssignee" }),
  workSessions: many(workSessions, { relationName: "workSessionUser" }),
  notifications: many(notifications, { relationName: "notificationUser" }),
  activityEvents: many(activityEvents, { relationName: "eventActor" }),
  savedViews: many(savedViews, { relationName: "savedViewOwner" }),
  automationsCreated: many(automations, { relationName: "automationCreator" }),
  dashboardLayout: one(dashboardLayouts, { fields: [users.id], references: [dashboardLayouts.userId], relationName: "dashboardUser" }),
}));

export const userNotificationPrefsRelations = relations(userNotificationPrefs, ({ one }) => ({
  user: one(users, { fields: [userNotificationPrefs.userId], references: [users.id] }),
}));

export const teamsRelations = relations(teams, ({ one, many }) => ({
  organisation: one(organisations, { fields: [teams.organisationId], references: [organisations.id] }),
  lead: one(users, { fields: [teams.leadUserId], references: [users.id], relationName: "teamLead" }),
  memberships: many(teamMemberships),
}));

export const teamMembershipsRelations = relations(teamMemberships, ({ one }) => ({
  team: one(teams, { fields: [teamMemberships.teamId], references: [teams.id] }),
  user: one(users, { fields: [teamMemberships.userId], references: [users.id], relationName: "membershipUser" }),
  addedBy: one(users, { fields: [teamMemberships.addedByUserId], references: [users.id], relationName: "membershipAddedBy" }),
  removedBy: one(users, { fields: [teamMemberships.removedByUserId], references: [users.id], relationName: "membershipRemovedBy" }),
}));

export const clientsRelations = relations(clients, ({ one, many }) => ({
  organisation: one(organisations, { fields: [clients.organisationId], references: [organisations.id] }),
  createdBy: one(users, { fields: [clients.createdByUserId], references: [users.id], relationName: "clientCreator" }),
  projects: many(projects),
  jobs: many(jobs),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organisation: one(organisations, { fields: [projects.organisationId], references: [organisations.id] }),
  client: one(clients, { fields: [projects.clientId], references: [clients.id] }),
  createdBy: one(users, { fields: [projects.createdByUserId], references: [users.id], relationName: "projectCreator" }),
  jobs: many(jobs),
}));

export const workflowsRelations = relations(workflows, ({ one, many }) => ({
  organisation: one(organisations, { fields: [workflows.organisationId], references: [organisations.id] }),
  createdBy: one(users, { fields: [workflows.createdByUserId], references: [users.id], relationName: "workflowCreator" }),
  statuses: many(workflowStatuses),
  transitions: many(workflowTransitions),
  jobTypes: many(jobTypes),
  jobs: many(jobs),
}));

export const workflowStatusesRelations = relations(workflowStatuses, ({ one, many }) => ({
  workflow: one(workflows, { fields: [workflowStatuses.workflowId], references: [workflows.id] }),
  outgoing: many(workflowTransitions, { relationName: "transitionFrom" }),
  incoming: many(workflowTransitions, { relationName: "transitionTo" }),
  jobs: many(jobs, { relationName: "jobStatus" }),
  stageEntries: many(jobStatusTransitions, { relationName: "jstTo" }),
}));

export const workflowTransitionsRelations = relations(workflowTransitions, ({ one }) => ({
  workflow: one(workflows, { fields: [workflowTransitions.workflowId], references: [workflows.id] }),
  from: one(workflowStatuses, { fields: [workflowTransitions.fromStatusId], references: [workflowStatuses.id], relationName: "transitionFrom" }),
  to: one(workflowStatuses, { fields: [workflowTransitions.toStatusId], references: [workflowStatuses.id], relationName: "transitionTo" }),
}));

export const jobTypesRelations = relations(jobTypes, ({ one, many }) => ({
  organisation: one(organisations, { fields: [jobTypes.organisationId], references: [organisations.id] }),
  workflow: one(workflows, { fields: [jobTypes.workflowId], references: [workflows.id] }),
  jobs: many(jobs),
}));

export const jobsRelations = relations(jobs, ({ one, many }) => ({
  organisation: one(organisations, { fields: [jobs.organisationId], references: [organisations.id] }),
  client: one(clients, { fields: [jobs.clientId], references: [clients.id] }),
  project: one(projects, { fields: [jobs.projectId], references: [projects.id] }),
  jobType: one(jobTypes, { fields: [jobs.jobTypeId], references: [jobTypes.id] }),
  workflow: one(workflows, { fields: [jobs.workflowId], references: [workflows.id] }),
  status: one(workflowStatuses, { fields: [jobs.statusId], references: [workflowStatuses.id], relationName: "jobStatus" }),
  previousStatus: one(workflowStatuses, { fields: [jobs.previousStatusId], references: [workflowStatuses.id], relationName: "jobPreviousStatus" }),
  photographer: one(users, { fields: [jobs.photographerId], references: [users.id], relationName: "jobPhotographer" }),
  editor: one(users, { fields: [jobs.editorId], references: [users.id], relationName: "jobEditor" }),
  previousEditor: one(users, { fields: [jobs.previousEditorId], references: [users.id], relationName: "jobPreviousEditor" }),
  approvedBy: one(users, { fields: [jobs.approvedByUserId], references: [users.id], relationName: "jobApprover" }),
  createdBy: one(users, { fields: [jobs.createdByUserId], references: [users.id], relationName: "jobCreator" }),
  openRevision: one(jobRevisions, { fields: [jobs.openRevisionId], references: [jobRevisions.id], relationName: "jobOpenRevision" }),
  assignments: many(jobAssignments),
  transitions: many(jobStatusTransitions),
  comments: many(jobComments),
  revisions: many(jobRevisions, { relationName: "jobRevisions" }),
  notes: many(jobNotes),
  links: many(jobLinks),
  workSessions: many(workSessions),
  activityEvents: many(activityEvents),
  notifications: many(notifications),
  automationRuns: many(automationRuns),
}));

export const jobAssignmentsRelations = relations(jobAssignments, ({ one }) => ({
  job: one(jobs, { fields: [jobAssignments.jobId], references: [jobs.id] }),
  user: one(users, { fields: [jobAssignments.userId], references: [users.id], relationName: "assignmentUser" }),
  assignedBy: one(users, { fields: [jobAssignments.assignedByUserId], references: [users.id], relationName: "assignmentAssignedBy" }),
  unassignedBy: one(users, { fields: [jobAssignments.unassignedByUserId], references: [users.id], relationName: "assignmentUnassignedBy" }),
  activityEvent: one(activityEvents, { fields: [jobAssignments.activityEventId], references: [activityEvents.id], relationName: "assignmentEvent" }),
}));

export const jobStatusTransitionsRelations = relations(jobStatusTransitions, ({ one, many }) => ({
  job: one(jobs, { fields: [jobStatusTransitions.jobId], references: [jobs.id] }),
  fromStatus: one(workflowStatuses, { fields: [jobStatusTransitions.fromStatusId], references: [workflowStatuses.id], relationName: "jstFrom" }),
  toStatus: one(workflowStatuses, { fields: [jobStatusTransitions.toStatusId], references: [workflowStatuses.id], relationName: "jstTo" }),
  actor: one(users, { fields: [jobStatusTransitions.actorUserId], references: [users.id], relationName: "transitionActor" }),
  editorAtEntry: one(users, { fields: [jobStatusTransitions.editorIdAtEntry], references: [users.id], relationName: "transitionEditorAtEntry" }),
  photographerAtEntry: one(users, { fields: [jobStatusTransitions.photographerIdAtEntry], references: [users.id], relationName: "transitionPhotographerAtEntry" }),
  automationRun: one(automationRuns, { fields: [jobStatusTransitions.automationRunId], references: [automationRuns.id], relationName: "transitionAutomationRun" }),
  activityEvent: one(activityEvents, { fields: [jobStatusTransitions.activityEventId], references: [activityEvents.id], relationName: "transitionEvent" }),
  workSessions: many(workSessions),
  revisionsRequested: many(jobRevisions, { relationName: "revisionRequestTransition" }),
  revisionsResolved: many(jobRevisions, { relationName: "revisionResolveTransition" }),
}));

export const jobRevisionsRelations = relations(jobRevisions, ({ one, many }) => ({
  job: one(jobs, { fields: [jobRevisions.jobId], references: [jobs.id], relationName: "jobRevisions" }),
  requestedBy: one(users, { fields: [jobRevisions.requestedByUserId], references: [users.id], relationName: "revisionRequester" }),
  assignee: one(users, { fields: [jobRevisions.assigneeUserId], references: [users.id], relationName: "revisionAssignee" }),
  resolvedBy: one(users, { fields: [jobRevisions.resolvedByUserId], references: [users.id], relationName: "revisionResolver" }),
  requestTransition: one(jobStatusTransitions, { fields: [jobRevisions.requestTransitionId], references: [jobStatusTransitions.id], relationName: "revisionRequestTransition" }),
  resolveTransition: one(jobStatusTransitions, { fields: [jobRevisions.resolveTransitionId], references: [jobStatusTransitions.id], relationName: "revisionResolveTransition" }),
  activityEvent: one(activityEvents, { fields: [jobRevisions.activityEventId], references: [activityEvents.id], relationName: "revisionEvent" }),
  responses: many(jobComments),
  notes: many(jobNotes),
}));

export const jobCommentsRelations = relations(jobComments, ({ one, many }) => ({
  job: one(jobs, { fields: [jobComments.jobId], references: [jobs.id] }),
  author: one(users, { fields: [jobComments.authorUserId], references: [users.id], relationName: "commentAuthor" }),
  deletedBy: one(users, { fields: [jobComments.deletedByUserId], references: [users.id], relationName: "commentDeletedBy" }),
  parent: one(jobComments, { fields: [jobComments.parentCommentId], references: [jobComments.id], relationName: "commentParent" }),
  replies: many(jobComments, { relationName: "commentParent" }),
  root: one(jobComments, { fields: [jobComments.rootCommentId], references: [jobComments.id], relationName: "commentRoot" }),
  thread: many(jobComments, { relationName: "commentRoot" }),
  revision: one(jobRevisions, { fields: [jobComments.revisionId], references: [jobRevisions.id] }),
  mentions: many(commentMentions),
}));

export const commentMentionsRelations = relations(commentMentions, ({ one }) => ({
  comment: one(jobComments, { fields: [commentMentions.commentId], references: [jobComments.id] }),
  user: one(users, { fields: [commentMentions.mentionedUserId], references: [users.id], relationName: "mentionedUser" }),
}));

export const jobNotesRelations = relations(jobNotes, ({ one }) => ({
  job: one(jobs, { fields: [jobNotes.jobId], references: [jobs.id] }),
  author: one(users, { fields: [jobNotes.authorUserId], references: [users.id], relationName: "noteAuthor" }),
  lastEditedBy: one(users, { fields: [jobNotes.lastEditedByUserId], references: [users.id], relationName: "noteLastEditedBy" }),
  archivedBy: one(users, { fields: [jobNotes.archivedByUserId], references: [users.id], relationName: "noteArchivedBy" }),
  revision: one(jobRevisions, { fields: [jobNotes.revisionId], references: [jobRevisions.id] }),
}));

export const jobLinksRelations = relations(jobLinks, ({ one }) => ({
  job: one(jobs, { fields: [jobLinks.jobId], references: [jobs.id] }),
  addedBy: one(users, { fields: [jobLinks.addedByUserId], references: [users.id], relationName: "linkAddedBy" }),
  removedBy: one(users, { fields: [jobLinks.removedByUserId], references: [users.id], relationName: "linkRemovedBy" }),
  supersedes: one(jobLinks, { fields: [jobLinks.supersedesLinkId], references: [jobLinks.id], relationName: "linkSupersedes" }),
  supersededBy: one(jobLinks, { fields: [jobLinks.supersededByLinkId], references: [jobLinks.id], relationName: "linkSupersededBy" }),
  activityEvent: one(activityEvents, { fields: [jobLinks.activityEventId], references: [activityEvents.id], relationName: "linkEvent" }),
}));

export const activityEventsRelations = relations(activityEvents, ({ one, many }) => ({
  organisation: one(organisations, { fields: [activityEvents.organisationId], references: [organisations.id] }),
  actor: one(users, { fields: [activityEvents.actorUserId], references: [users.id], relationName: "eventActor" }),
  job: one(jobs, { fields: [activityEvents.jobId], references: [jobs.id] }),
  automationRun: one(automationRuns, { fields: [activityEvents.automationRunId], references: [automationRuns.id], relationName: "eventAutomationRun" }),
  notifications: many(notifications),
  triggeredRuns: many(automationRuns, { relationName: "runTriggerEvent" }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id], relationName: "notificationUser" }),
  actor: one(users, { fields: [notifications.actorUserId], references: [users.id], relationName: "notificationActor" }),
  job: one(jobs, { fields: [notifications.jobId], references: [jobs.id] }),
  event: one(activityEvents, { fields: [notifications.activityEventId], references: [activityEvents.id] }),
}));

export const workSessionsRelations = relations(workSessions, ({ one }) => ({
  job: one(jobs, { fields: [workSessions.jobId], references: [jobs.id] }),
  user: one(users, { fields: [workSessions.userId], references: [users.id], relationName: "workSessionUser" }),
  transition: one(jobStatusTransitions, { fields: [workSessions.transitionId], references: [jobStatusTransitions.id] }),
  statusAtStart: one(workflowStatuses, { fields: [workSessions.statusIdAtStart], references: [workflowStatuses.id], relationName: "sessionStatusAtStart" }),
}));

export const automationsRelations = relations(automations, ({ one, many }) => ({
  organisation: one(organisations, { fields: [automations.organisationId], references: [organisations.id] }),
  createdBy: one(users, { fields: [automations.createdByUserId], references: [users.id], relationName: "automationCreator" }),
  runs: many(automationRuns),
}));

export const automationRunsRelations = relations(automationRuns, ({ one, many }) => ({
  automation: one(automations, { fields: [automationRuns.automationId], references: [automations.id] }),
  triggerEvent: one(activityEvents, { fields: [automationRuns.triggerEventId], references: [activityEvents.id], relationName: "runTriggerEvent" }),
  job: one(jobs, { fields: [automationRuns.jobId], references: [jobs.id] }),
  producedEvents: many(activityEvents, { relationName: "eventAutomationRun" }),
  producedTransitions: many(jobStatusTransitions, { relationName: "transitionAutomationRun" }),
}));

export const savedViewsRelations = relations(savedViews, ({ one }) => ({
  owner: one(users, { fields: [savedViews.ownerUserId], references: [users.id], relationName: "savedViewOwner" }),
}));

export const dashboardLayoutsRelations = relations(dashboardLayouts, ({ one }) => ({
  user: one(users, { fields: [dashboardLayouts.userId], references: [users.id], relationName: "dashboardUser" }),
}));

/* ------------------------------------------------------------------ */
/*  Table registry (used by guard.ts, verify.ts and tests)             */
/* ------------------------------------------------------------------ */

export const TABLE_NAMES = [
  "organisations",
  "organisation_settings",
  "users",
  "user_notification_prefs",
  "auth_tokens",
  "teams",
  "team_memberships",
  "clients",
  "projects",
  "workflows",
  "workflow_statuses",
  "workflow_transitions",
  "job_types",
  "jobs",
  "job_assignments",
  "job_status_transitions",
  "job_revisions",
  "job_comments",
  "comment_mentions",
  "job_notes",
  "job_links",
  "activity_events",
  "notifications",
  "work_sessions",
  "automations",
  "automation_runs",
  "saved_views",
  "dashboard_layouts",
] as const;
export type TableName = (typeof TABLE_NAMES)[number];

/** Tables protected by append-only / fill-once triggers (src/db/guard.ts). */
export const LEDGER_TABLES = [
  "activity_events",
  "job_status_transitions",
  "job_assignments",
  "job_revisions",
  "job_links",
  "job_comments",
  "work_sessions",
  "automation_runs",
  "notifications",
  "team_memberships",
  "auth_tokens",
] as const satisfies readonly TableName[];
