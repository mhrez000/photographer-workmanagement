/**
 * Shared TypeScript types.
 *
 * Part 1 re-exports Drizzle row types for every table (Select = row read from
 * the DB, Insert = values accepted by insert). Part 2 holds the view-model
 * types pages and components consume from `src/server/queries/*`. Components
 * never import `src/db` — they import from here.
 */
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type * as s from "@/db/schema";
import type {
  Action,
  BottleneckKind,
  ClientMilestone,
  EditorFlag,
  MemberFlag,
  Persona,
  EventCause,
  EventType,
  EventVisibility,
  KanbanColumn,
  KpiBucket,
  LinkKind,
  NoteKind,
  NotificationType,
  Priority,
  Role,
  StatusCategory,
  TransitionRole,
  ViewScope,
  WorkloadBand,
} from "./constants";

/* ------------------------------------------------------------------ */
/*  Part 1 — table row types                                           */
/* ------------------------------------------------------------------ */

export type Organisation = InferSelectModel<typeof s.organisations>;
export type NewOrganisation = InferInsertModel<typeof s.organisations>;
export type OrganisationSettings = InferSelectModel<typeof s.organisationSettings>;
export type NewOrganisationSettings = InferInsertModel<typeof s.organisationSettings>;
export type User = InferSelectModel<typeof s.users>;
export type NewUser = InferInsertModel<typeof s.users>;
export type UserNotificationPref = InferSelectModel<typeof s.userNotificationPrefs>;
export type NewUserNotificationPref = InferInsertModel<typeof s.userNotificationPrefs>;
export type Team = InferSelectModel<typeof s.teams>;
export type NewTeam = InferInsertModel<typeof s.teams>;
export type TeamMembership = InferSelectModel<typeof s.teamMemberships>;
export type NewTeamMembership = InferInsertModel<typeof s.teamMemberships>;
export type Client = InferSelectModel<typeof s.clients>;
export type NewClient = InferInsertModel<typeof s.clients>;
export type Project = InferSelectModel<typeof s.projects>;
export type NewProject = InferInsertModel<typeof s.projects>;
export type Workflow = InferSelectModel<typeof s.workflows>;
export type NewWorkflow = InferInsertModel<typeof s.workflows>;
export type WorkflowStatus = InferSelectModel<typeof s.workflowStatuses>;
export type NewWorkflowStatus = InferInsertModel<typeof s.workflowStatuses>;
export type WorkflowTransition = InferSelectModel<typeof s.workflowTransitions>;
export type NewWorkflowTransition = InferInsertModel<typeof s.workflowTransitions>;
export type JobType = InferSelectModel<typeof s.jobTypes>;
export type NewJobType = InferInsertModel<typeof s.jobTypes>;
export type Job = InferSelectModel<typeof s.jobs>;
export type NewJob = InferInsertModel<typeof s.jobs>;
export type JobAssignment = InferSelectModel<typeof s.jobAssignments>;
export type NewJobAssignment = InferInsertModel<typeof s.jobAssignments>;
export type JobStatusTransition = InferSelectModel<typeof s.jobStatusTransitions>;
export type NewJobStatusTransition = InferInsertModel<typeof s.jobStatusTransitions>;
export type JobRevision = InferSelectModel<typeof s.jobRevisions>;
export type NewJobRevision = InferInsertModel<typeof s.jobRevisions>;
export type JobComment = InferSelectModel<typeof s.jobComments>;
export type NewJobComment = InferInsertModel<typeof s.jobComments>;
export type CommentMention = InferSelectModel<typeof s.commentMentions>;
export type NewCommentMention = InferInsertModel<typeof s.commentMentions>;
export type JobNote = InferSelectModel<typeof s.jobNotes>;
export type NewJobNote = InferInsertModel<typeof s.jobNotes>;
export type JobLink = InferSelectModel<typeof s.jobLinks>;
export type NewJobLink = InferInsertModel<typeof s.jobLinks>;
export type ActivityEvent = InferSelectModel<typeof s.activityEvents>;
export type NewActivityEvent = InferInsertModel<typeof s.activityEvents>;
export type Notification = InferSelectModel<typeof s.notifications>;
export type NewNotification = InferInsertModel<typeof s.notifications>;
export type WorkSession = InferSelectModel<typeof s.workSessions>;
export type NewWorkSession = InferInsertModel<typeof s.workSessions>;
export type Automation = InferSelectModel<typeof s.automations>;
export type NewAutomation = InferInsertModel<typeof s.automations>;
export type AutomationRun = InferSelectModel<typeof s.automationRuns>;
export type NewAutomationRun = InferInsertModel<typeof s.automationRuns>;
export type SavedView = InferSelectModel<typeof s.savedViews>;
export type NewSavedView = InferInsertModel<typeof s.savedViews>;
export type DashboardLayoutRow = InferSelectModel<typeof s.dashboardLayouts>;
export type NewDashboardLayoutRow = InferInsertModel<typeof s.dashboardLayouts>;

export type {
  AutomationAction,
  AutomationActionResult,
  AutomationCondition,
  AutomationTrigger,
  DashboardLayout,
  Json,
  SavedViewConfig,
  TransitionKind,
} from "@/db/schema";

/* ------------------------------------------------------------------ */
/*  Part 2 — auth & request context                                    */
/* ------------------------------------------------------------------ */

/** Session kind claim `k` (docs/ROLES.md §7.8): routing hint for the proxy only (unverified there). */
export type SessionKind = "staff" | "client";

/** Signed into the jose cookie: user id + session version (+ kind; a missing claim = staff). */
export interface SessionPayload {
  sub: string;
  sv: number;
  k?: SessionKind;
}

/**
 * Organisation settings copied into the context at request time. Roles v2 removed the
 * four org-wide visibility switches (photographersSeeAllJobs, photographersSeeTeamJobs,
 * editorsSeeTeamJobs, editorsSeeTeamWorkloads): visibility is per person now.
 */
export interface ContextSettings {
  timezone: string;
  timeTrackingEnabled: boolean;
  automationsEnabled: boolean;
  /** organisation_settings.audit_notifications (write a notification.sent event per notification). */
  auditNotifications?: boolean;
}

/**
 * Resolved per request from the cookie + a fresh users row (never cached
 * across requests). `systemContext(orgId)` builds the variant used by the
 * automation runner and the overdue sweep.
 */
export interface AuthContext {
  userId: string | null;
  organisationId: string;
  /** System context: "photographer". */
  role: Role;
  /** Admin (owner / co-owner). System context: true. Only ever true for role = photographer. */
  isAdmin: boolean;
  /** organisation_settings.primary_owner_user_id = me. System context: false. */
  isPrimaryOwner: boolean;
  isActive: boolean;
  // EFFECTIVE switches, never raw columns (docs/ROLES.md §2.1). Admin => all six member switches
  // true. Clients => every switch false. A switch outside its role is false.
  /** admin yes; member / editor = column; client no */
  canCreateJobs: boolean;
  /** admin yes; member = column; editor no */
  canViewAllJobs: boolean;
  /** admin yes; member = column; editor no */
  canAssignEditors: boolean;
  /** admin yes; member = column; editor no */
  canReviewSubmissions: boolean;
  /** admin yes; member = column; editor no */
  canViewTeamWorkloads: boolean;
  /** admin yes; member = column; editor no */
  canViewAnalytics: boolean;
  /** editor = column; everyone else false (admins / all-jobs members already see every job) */
  canViewTeamJobs: boolean;
  /** Client users only: their client. */
  clientId: string | null;
  /** Client users only: clients.feedback_enabled. */
  clientFeedbackEnabled: boolean;
  /** Active teammates' user ids. Kept for grouping; NOT used for visibility any more (roles v2). */
  teamUserIds: ReadonlySet<string>;
  settings: ContextSettings;
  /** true only for the system context (automations / sweep / seed). */
  isSystem: boolean;
  /** Injectable clock (seed/tests override). */
  now: () => string;
  /** Request correlation id written into event metadata. */
  requestId: string;
  /**
   * Default `metadata.cause` for events written with this context. Omitted →
   * "user" for human contexts, "sweep" for the system context.
   */
  cause?: EventCause;
  /** Set by the automation runner: stamped on events (activity_events.automation_run_id). */
  automationRunId?: string | null;
}

/* ------------------------------------------------------------------ */
/*  Part 2 — small references used across view models                  */
/* ------------------------------------------------------------------ */

export interface UserRef {
  id: string;
  name: string;
  role: Role;
  avatarColour: string;
  isActive: boolean;
  /** Roles v2: set where the persona badge is shown (personaLabel). Optional while queries are ported. */
  isAdmin?: boolean;
  isPrimaryOwner?: boolean;
  title?: string | null;
}

/**
 * Reduced user projection for members and editors (docs/ROLES.md §3.4): never
 * email, phone or other private fields.
 */
export interface ReducedUser {
  id: string;
  name: string;
  title: string | null;
  role: Role;
  isAdmin: boolean;
  isPrimaryOwner: boolean;
  avatarColour: string;
  isActive: boolean;
}

export interface StatusRef {
  id: string;
  key: string;
  name: string;
  category: StatusCategory;
  colour: string;
  sortOrder: number;
}

export interface ClientRef {
  id: string;
  name: string;
}

export interface ProjectRef {
  id: string;
  name: string;
  clientId: string;
}

export interface JobTypeRef {
  id: string;
  name: string;
  colour: string;
}

export interface JobRef {
  id: string;
  jobNumber: string;
  name: string;
}

/** Ownership/visibility facts the permission layer needs about a job (docs/ROLES.md §2.1). */
export interface JobPermissionRef {
  id: string;
  organisationId: string;
  photographerId: string | null;
  editorId: string | null;
  createdByUserId: string;
  /** Role of the creator at creation (jobs.created_by_role). */
  createdByRole: "photographer" | "editor";
  statusCategory: StatusCategory;
  isPaused: boolean;
  /** Every editor who ever held the job (incl. the current one). Loaded for every actor (self-review rule). */
  pastEditorIds?: readonly string[];
  /** Editor draft window closed for good: ever started, an editor removed by someone else, or ever cancelled. */
  draftClosed: boolean;
  clientId: string;
  /** jobs.shared_with_client */
  sharedWithClient: boolean;
  /** projects.shared_with_client of the job's project */
  projectSharedWithClient: boolean;
  /** jobs.cancelled_at (portal: cancelled jobs stay visible for PORTAL_CANCELLED_VISIBLE_DAYS). */
  cancelledAt?: string | null;
}

/** What the client portal checks about a job (`portal.view_job`, `portal.give_feedback`). */
export interface PortalJobRef {
  id: string;
  organisationId: string;
  clientId: string;
  sharedWithClient: boolean;
  projectSharedWithClient: boolean;
  statusCategory: StatusCategory;
  cancelledAt?: string | null;
}

/* ------------------------------------------------------------------ */
/*  Part 2 — jobs                                                      */
/* ------------------------------------------------------------------ */

/** One row of All Work / Jobs / Team Work tables (spec §8). */
export interface JobRow {
  id: string;
  jobNumber: string;
  name: string;
  client: ClientRef;
  project: ProjectRef;
  jobType: JobTypeRef;
  photographer: UserRef | null;
  editor: UserRef | null;
  status: StatusRef;
  statusCategory: StatusCategory;
  statusEnteredAt: string;
  priority: Priority;
  createdAt: string;
  shootDate: string | null;
  dueDate: string | null;
  reviewDueDate: string | null;
  deliveryDueDate: string | null;
  /** Negative = overdue; null = no due date. */
  daysRemaining: number | null;
  isOverdue: boolean;
  isDueToday: boolean;
  isPaused: boolean;
  revisionCount: number;
  lastActivityAt: string;
  completionPercent: number;
  /** Most relevant current link: finished work when present, else editing workspace, else raw files. */
  primaryLink: { id: string; kind: LinkKind; url: string; label: string | null } | null;
  estimatedHours: number | null;
  version: number;
  /** Seconds since the job entered its current status (`now − statusEnteredAt`); set by src/server/queries. */
  timeInStatusSeconds?: number;
}

export interface LinkView {
  id: string;
  kind: LinkKind;
  url: string;
  label: string | null;
  provider: string | null;
  addedBy: UserRef;
  createdAt: string;
  supersedesLinkId: string | null;
  supersededAt: string | null;
  supersededByLinkId: string | null;
  removedAt: string | null;
  removedBy: UserRef | null;
  removeReason: string | null;
  isCurrent: boolean;
  /** Roles v2: job_links.shared_with_client (visible in the client portal while current). */
  sharedWithClient?: boolean;
}

export interface LinkSlot {
  kind: LinkKind;
  current: LinkView | null;
  /** Oldest → newest, including the current row. */
  history: LinkView[];
}

export interface NoteView {
  id: string;
  kind: NoteKind;
  body: string;
  author: UserRef;
  lastEditedBy: UserRef | null;
  editCount: number;
  revisionId: string | null;
  isPinned: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface CommentNode {
  id: string;
  parentCommentId: string | null;
  rootCommentId: string;
  revisionId: string | null;
  author: UserRef;
  kind: JobComment["kind"];
  /** null when soft-deleted (placeholder rendered). */
  body: string | null;
  mentions: UserRef[];
  editedAt: string | null;
  editCount: number;
  deletedAt: string | null;
  createdAt: string;
  /** Author may still edit (within the window, not deleted). */
  canEdit: boolean;
  replies: CommentNode[];
}

export interface RevisionView {
  id: string;
  revisionNumber: number;
  reason: string;
  description: string;
  instructions: string | null;
  priority: Priority;
  dueDate: string | null;
  requestedBy: UserRef;
  assignee: UserRef | null;
  requestedAt: string;
  resolvedAt: string | null;
  resolvedBy: UserRef | null;
  resolution: JobRevision["resolution"];
  resolutionNote: string | null;
  /** Seconds between request and resolution (null while open). */
  cycleSeconds: number | null;
  isOpen: boolean;
}

export interface AssignmentView {
  id: string;
  role: JobAssignment["role"];
  user: UserRef;
  assignedBy: UserRef | null;
  assignedAt: string;
  unassignedAt: string | null;
  unassignedBy: UserRef | null;
  unassignReason: JobAssignment["unassignReason"];
  reason: string | null;
  isCurrent: boolean;
}

/** One stage occupancy (job_status_transitions row) for History / Timeline. */
export interface StageView {
  id: string;
  sequence: number;
  kind: JobStatusTransition["kind"];
  fromStatus: StatusRef | null;
  toStatus: StatusRef;
  fromCategory: StatusCategory | null;
  toCategory: StatusCategory;
  statusName: string;
  actor: UserRef | null;
  reason: string | null;
  isReopen: boolean;
  isOverride: boolean;
  enteredAt: string;
  exitedAt: string | null;
  durationSeconds: number;
  isCurrent: boolean;
  editorAtEntry: UserRef | null;
  photographerAtEntry: UserRef | null;
  /** Tracked active seconds in this stage (time tracking only). */
  activeSeconds: number;
}

export interface WorkSessionView {
  id: string;
  user: UserRef;
  statusCategory: StatusCategory;
  statusName: string;
  startedAt: string;
  endedAt: string | null;
  endReason: WorkSession["endReason"];
  durationSeconds: number;
  isRunning: boolean;
  note: string | null;
}

/** Action buttons the current actor may press on a job (computed server-side). */
export interface JobAvailableActions {
  transitions: {
    toStatus: StatusRef;
    label: string;
    isReopen: boolean;
    requiresRevisionPayload: boolean;
    requiresReason: boolean;
  }[];
  canEditFields: boolean;
  canEditDeadlines: boolean;
  canSetPriority: boolean;
  canAssignEditor: boolean;
  canAssignPhotographer: boolean;
  canCancel: boolean;
  canRestore: boolean;
  canPause: boolean;
  canResume: boolean;
  canAddLinkKinds: LinkKind[];
  canAddNoteKinds: NoteKind[];
  canComment: boolean;
  canUseTimer: boolean;
  canRequestRevision: boolean;
  canWithdrawRevision: boolean;
}

/** Full job detail bundle (`GET /api/jobs/:id`, `/jobs/[id]`). */
export interface JobDetail {
  job: JobRow & {
    description: string | null;
    workflowId: string;
    previousStatus: StatusRef | null;
    previousEditor: UserRef | null;
    createdBy: UserRef;
    approvedBy: UserRef | null;
    startedAt: string | null;
    firstSubmittedAt: string | null;
    lastSubmittedAt: string | null;
    approvedAt: string | null;
    dueDateAtApproval: string | null;
    deliveredAt: string | null;
    completedAt: string | null;
    dueDateAtCompletion: string | null;
    wasOnTime: boolean | null;
    cancelledAt: string | null;
    reopenedCount: number;
    pausedAt: string | null;
    updatedAt: string;
    /** Roles v2 client sharing (job / its project) and the creator's role at creation. */
    sharedWithClient?: boolean;
    projectSharedWithClient?: boolean;
    createdByRole?: "photographer" | "editor";
  };
  workflowStatuses: StatusRef[];
  links: LinkSlot[];
  finishedWork: LinkView[];
  notes: NoteView[];
  comments: CommentNode[];
  revisions: RevisionView[];
  openRevision: RevisionView | null;
  assignments: AssignmentView[];
  stages: StageView[];
  sessions: WorkSessionView[];
  runningSession: WorkSessionView | null;
  metrics: {
    turnaroundSeconds: number | null;
    editingSeconds: number;
    reviewSeconds: number;
    activeEditingSeconds: number | null;
    timeInCurrentStatusSeconds: number;
    secondsPerCategory: Partial<Record<StatusCategory, number>>;
  };
  actions: JobAvailableActions;
}

/* ------------------------------------------------------------------ */
/*  Part 2 — dashboard, workloads, analytics                           */
/* ------------------------------------------------------------------ */

export interface KpiSummary {
  active: number;
  dueToday: number;
  overdue: number;
  awaitingEditor: number;
  inEditing: number;
  awaitingReview: number;
  revisionRequired: number;
  completedThisWeek: number;
  /** Extras surfaced by widgets. */
  unassigned: number;
  paused: number;
  reviewOverdue: number;
  asOf: string;
  /** [from, to) instants of the week `completedThisWeek` counts (organisation week start), for drill-down links. */
  completedWeek?: { from: string; to: string };
}

export interface WorkloadRow {
  editor: UserRef & { capacityHoursPerWeek: number };
  assigned: number;
  accepted: number;
  inProgress: number;
  revision: number;
  awaitingReview: number;
  active: number;
  dueToday: number;
  dueWithin48h: number;
  overdue: number;
  paused: number;
  completedThisWeek: number;
  completedThisMonth: number;
  /** 0..1 — jobs with ≥1 revision ÷ jobs approved in range. */
  revisionRate: number | null;
  score: number;
  ratio: number;
  band: WorkloadBand;
  /** Reason the band was forced (e.g. hard cap) — null when ratio-driven. */
  bandReason: "ratio" | "max_active" | "overdue_cap" | "inactive";
}

export interface WorkloadHistoryPoint {
  /** Civil date in org timezone (YYYY-MM-DD). */
  date: string;
  count: number;
  score: number;
}

export interface WorkloadDetail extends WorkloadRow {
  currentJobs: JobRow[];
  overdueJobs: JobRow[];
  recentCompleted: JobRow[];
  avgTurnaroundSeconds: number | null;
  avgEditingSeconds: number | null;
  avgReviewSeconds: number | null;
  onTimePercent: number | null;
  secondsPerCategory: Partial<Record<StatusCategory, number>>;
  history: WorkloadHistoryPoint[];
}

export interface BottleneckAlert {
  kind: BottleneckKind;
  severity: "warning" | "critical";
  /** e.g. "Review bottleneck — 7 jobs waiting for review > 24h" */
  message: string;
  count: number;
  user: UserRef | null;
  jobs: JobRef[];
  /** Where the banner links to. */
  href: string;
  detectedAt: string;
  /**
   * Affected jobs left out of `jobs` because the viewer may not open them
   * (non-management viewers; `count` stays organisation-wide). 0 / absent =
   * every affected job is listed.
   */
  hiddenJobCount?: number;
}

export interface PerformanceRow {
  user: UserRef;
  completed: number;
  approved: number;
  avgTurnaroundSeconds: number | null;
  avgEditingSeconds: number | null;
  avgReviewSeconds: number | null;
  revisionRate: number | null;
  revisionsPerJob: number | null;
  onTimePercent: number | null;
  overdue: number;
  active: number;
  completedThisWeek: number;
  completedThisMonth: number;
}

export interface PhotographerPerformanceRow {
  user: UserRef;
  created: number;
  submitted: number;
  completed: number;
  /** firstSubmittedAt − shootDate */
  avgProcessingSeconds: number | null;
  avgEndToEndSeconds: number | null;
  avgReviewResponseSeconds: number | null;
  active: number;
  overdue: number;
}

export interface TrendPoint {
  /** Bucket start as civil date (YYYY-MM-DD). */
  date: string;
  created: number;
  completed: number;
  revisionsRequested: number;
  becameOverdue: number;
  avgTurnaroundSeconds: number | null;
  /** Jobs approved in the bucket (denominator of the two rates below). */
  approved?: number;
  /** 0..100 over jobs approved in the bucket with a due date; null when none. */
  onTimePercent?: number | null;
  /** 0..1 — approved jobs in the bucket that needed ≥1 revision; null when none approved. */
  revisionRate?: number | null;
}

export interface AnalyticsOverview {
  range: ResolvedRange;
  kpis: KpiSummary;
  completed: number;
  outstanding: number;
  overdue: number;
  avgTurnaroundSeconds: number | null;
  onTimePercent: number | null;
  revisionRate: number | null;
  completionRate: number | null;
  capacityHours: number;
  loadHours: number;
  trend: TrendPoint[];
  byJobType: { jobType: JobTypeRef; created: number; completed: number; avgTurnaroundSeconds: number | null }[];
  byClient: { client: ClientRef; created: number; completed: number; overdue: number }[];
}

export interface ResolvedRange {
  preset: "today" | "this_week" | "this_month" | "last_month" | "last_7_days" | "last_30_days" | "custom";
  /** Inclusive ISO start, exclusive ISO end (UTC). */
  from: string;
  to: string;
  label: string;
}

/* ------------------------------------------------------------------ */
/*  Part 2 — timeline, calendar, kanban, feeds                          */
/* ------------------------------------------------------------------ */

/** A stage bar on the Gantt (spec §11). */
export interface TimelineEvent {
  jobId: string;
  jobNumber: string;
  jobName: string;
  stageId: string;
  category: StatusCategory;
  statusName: string;
  startAt: string;
  endAt: string | null;
  durationSeconds: number;
  editor: UserRef | null;
  /** Longer than N× the org average for this category. */
  isBottleneck: boolean;
  isCurrent: boolean;
}

export interface TimelineRow {
  job: JobRef & {
    priority: Priority;
    dueDate: string | null;
    editor: UserRef | null;
    photographer: UserRef | null;
    statusCategory: StatusCategory;
    /** Set by getTimelineRows / getJobTimelineRow (Gantt labels and the project grouping). */
    client?: ClientRef;
    project?: { id: string; name: string };
  };
  segments: TimelineEvent[];
}

export type CalendarEventKind = "shoot" | "due" | "review_due" | "delivery_due" | "revision_due";

export interface CalendarEvent {
  id: string;
  kind: CalendarEventKind;
  /** ISO instant; rendered on its civil day in org timezone. */
  at: string;
  job: JobRef & { priority: Priority; statusCategory: StatusCategory; status: StatusRef; editor: UserRef | null; photographer: UserRef | null };
  isOverdue: boolean;
  revisionNumber?: number;
}

export interface KanbanCard extends JobRow {
  /** Columns the card may be dropped into for the current actor. */
  allowedColumns: KanbanColumn[];
}

export interface KanbanColumnView {
  column: KanbanColumn;
  label: string;
  categories: StatusCategory[];
  cards: KanbanCard[];
  count: number;
}

/** One rendered line of the activity feed / job Activity tab (spec §37). */
export interface ActivityFeedItem {
  id: string;
  eventType: EventType;
  action: ActivityEvent["action"];
  entityType: ActivityEvent["entityType"];
  entityId: string;
  actor: UserRef | null;
  isSystem: boolean;
  job: JobRef | null;
  /** Actor-less frozen sentence; UI renders "<actor> <summary>". */
  summary: string;
  /** Full feed line incl. actor and job (describeEventForFeed), e.g. `Sarah completed “PJ-0007 Smith St”`. */
  sentence?: string;
  previousValue: unknown;
  newValue: unknown;
  metadata: Record<string, unknown>;
  visibility: EventVisibility;
  createdAt: string;
}

export interface HistoryEntry {
  /** Milestone entries only (HISTORY_EVENT_TYPES) merged with stage rows. */
  at: string;
  kind: "stage" | "event";
  stage?: StageView;
  event?: ActivityFeedItem;
}

export interface NotificationView {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  linkPath: string;
  job: JobRef | null;
  actor: UserRef | null;
  readAt: string | null;
  createdAt: string;
}

export interface SearchResults {
  query: string;
  jobs: (JobRef & { status: StatusRef; client: ClientRef; matchedIn: "number" | "name" | "note" | "comment" | "description" | "status" })[];
  clients: ClientRef[];
  projects: (ProjectRef & { client: ClientRef })[];
  users: UserRef[];
  /** When the query is an exact job number, deep-link target. */
  exactJob: JobRef | null;
}

export interface MyWorkQueue {
  dueToday: JobRow[];
  dueTomorrow: JobRow[];
  upcoming: JobRow[];
  overdue: JobRow[];
  waitingForReview: JobRow[];
  revisionRequired: JobRow[];
  paused: JobRow[];
  runningSession: WorkSessionView | null;
}

export interface TeamWorkGroup {
  user: UserRef;
  workload: WorkloadRow | null;
  jobs: JobRow[];
}

/* ------------------------------------------------------------------ */
/*  Part 2 — misc API shapes                                            */
/* ------------------------------------------------------------------ */

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

export interface ApiErrorBody {
  error: {
    code:
      | "validation"
      | "unauthorized"
      | "forbidden"
      | "not_found"
      | "conflict"
      | "invalid_transition"
      | "ambiguous_target"
      | "editor_required"
      | "rate_limited"
      | "internal";
    message: string;
    details?: unknown;
    /** For 409: the current row so the client can show a conflict dialog. */
    current?: unknown;
  };
}

export interface BulkResult {
  ok: string[];
  failed: { id: string; code: ApiErrorBody["error"]["code"]; message: string }[];
  batchId: string;
}

export interface IntegrityReport {
  checkedAt: string;
  jobsChecked: number;
  drift: { jobId: string; column: string; stored: unknown; derived: unknown }[];
  structural: { check: string; jobId: string | null; detail: string }[];
  ok: boolean;
}

/** Shape of the Roles settings page rows (rendered from PERMISSIONS + POLICY). */
export interface PermissionMatrixCell {
  allowed: boolean;
  /** Scope note ("managed jobs", "any", ...) or "never". */
  scope: string;
  /** Member switch the cell needs (Roles page: "needs: Review submissions"). */
  memberFlag?: MemberFlag;
  /** Editor switch the cell needs. */
  editorFlag?: EditorFlag;
}

export interface PermissionMatrixRow {
  action: Action;
  label: string;
  cells: Record<Persona, PermissionMatrixCell>;
}

/* ------------------------------------------------------------------ */
/*  Part 2 — client portal view models (docs/ROLES.md §7.4)            */
/*  Built only by the whitelist mapper toPortalJob(); never spread a row */
/* ------------------------------------------------------------------ */

export interface PortalProject {
  id: string;
  name: string;
  address: string | null;
}

/** One step of the Booked > Shot > Editing > Delivered stepper. */
export interface PortalMilestone {
  key: ClientMilestone;
  label: string;
  state: "done" | "current" | "upcoming";
  /** Agreed date shown under the step (shoot date for Booked/Shot, delivered/delivery date for Delivered). */
  date: string | null;
}

export interface PortalLink {
  id: string;
  kind: LinkKind;
  label: string | null;
  url: string;
  provider: string | null;
}

/** A delivery note (job_notes kind "delivery", not archived). */
export interface PortalNote {
  id: string;
  body: string;
  createdAt: string;
  authorName: string;
}

export interface PortalFeedbackMessage {
  id: string;
  /** Plain text; empty when deleted. */
  body: string;
  authorName: string;
  /** Written by a client user (else the studio). */
  isClient: boolean;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
}

/** A client_feedback thread whose root author is a user of the viewer's client. */
export interface PortalFeedbackThread extends PortalFeedbackMessage {
  replies: PortalFeedbackMessage[];
}

/** Portal list item. Never: editors, statuses, priority, due/review dates, revisions, internal notes, emails. */
export interface PortalJob {
  id: string;
  jobNumber: string;
  name: string;
  project: PortalProject;
  jobTypeName: string;
  /** null = cancelled. */
  milestone: ClientMilestone | null;
  milestoneLabel: string;
  milestoneDetail: string | null;
  /** Reopened after delivery ("Updating your delivery"). */
  updating: boolean;
  cancelled: boolean;
  shootDate: string | null;
  /** The agreed delivery date. */
  deliveryDueDate: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  photographer: { name: string } | null;
}

export interface PortalJobDetail extends PortalJob {
  links: PortalLink[];
  deliveryNotes: PortalNote[];
  feedback: PortalFeedbackThread[];
  canGiveFeedback: boolean;
}

/** /portal grouping: jobs by project. */
export interface PortalProjectGroup {
  project: PortalProject;
  jobs: PortalJob[];
}

/** Portal header + GET /api/auth/me for clients (client-safe shape, §7.7). */
export interface PortalViewer {
  kind: "client";
  name: string;
  email: string;
  clientName: string;
  studioName: string;
  unreadCount: number;
}

export type { Action, KpiBucket };

/** The actor's running timer with its job (topbar pill, My Work). */
export interface RunningSessionView extends WorkSessionView {
  job: JobRef;
}

/** One entry of a note's edit-history drawer (read from note.* activity events). */
export interface NoteHistoryEntry {
  eventId: string;
  eventType: "note.added" | "note.edited" | "note.archived" | "note.restored";
  at: string;
  actor: UserRef | null;
  previousBody: string | null;
  newBody: string | null;
  editCount: number | null;
}

/** Time-tracking totals for a job (Time tab). Running sessions count up to now. */
export interface SessionTotals {
  totalSeconds: number;
  runningCount: number;
  byUser: { user: UserRef; seconds: number }[];
  byCategory: Partial<Record<StatusCategory, number>>;
}

/* ------------------------------------------------------------------ */
/*  Part 3 — read-side queries part 2 (dashboard, analytics, reports,  */
/*  directories, settings views). Produced by src/server/queries/*.    */
/* ------------------------------------------------------------------ */

/** A user row without secrets (same shape as services/_shared SafeUser). */
export type UserProfile = Omit<User, "passwordHash" | "sessionVersion">;

/** Mean closed-stage duration per category (stage averages). */
export interface StageAverage {
  category: StatusCategory;
  avgSeconds: number;
  /** Closed stage rows measured. */
  count: number;
}

/** Declaration merge: per-person tables and stage averages on the analytics overview. */
export interface AnalyticsOverview {
  editors?: PerformanceRow[];
  photographers?: PhotographerPerformanceRow[];
  stageAverages?: StageAverage[];
}

/** `/team/performance`: both tables for one range. */
export interface PerformanceReport {
  range: ResolvedRange;
  editors: PerformanceRow[];
  photographers: PhotographerPerformanceRow[];
}

/** `/api/analytics/editors/:userId`. */
export interface EditorAnalytics {
  range: ResolvedRange;
  editor: UserRef;
  performance: PerformanceRow;
  trend: TrendPoint[];
  stageAverages: StageAverage[];
}

/** `/api/analytics/me` (My Performance). */
export interface MyAnalytics {
  range: ResolvedRange;
  role: Role;
  /** Editing performance (editors, or anyone who edited in range). */
  editor: PerformanceRow | null;
  /** Shooting performance (photographers). */
  photographer: PhotographerPerformanceRow | null;
  trend: TrendPoint[];
  stageAverages: StageAverage[];
}

export interface DashboardPersonal {
  myWorkload: WorkloadRow | null;
  myPerformance: PerformanceRow | null;
  myPhotographerPerformance: PhotographerPerformanceRow | null;
  /** Next jobs for the actor (editor: held jobs; photographer: own jobs), overdue first then by due date. */
  queuePreview: JobRow[];
}

/** An open editor question or a waiting client-feedback thread (`questions` widget, docs/ROLES.md §6.4 / §7.5). */
export interface DashboardQuestion {
  /** Root comment of the thread. */
  commentId: string;
  kind: "question" | "client_feedback";
  job: JobRef;
  author: UserRef;
  /** Plain-text excerpt of the latest message (≤ 200 chars). */
  excerpt: string;
  /** When the thread started waiting (latest message). */
  waitingSince: string;
}

/** A due / review-due / delivery-due date in the next 7 days (`upcoming_deadlines` widget). */
export interface DashboardDeadline {
  job: JobRow;
  kind: "due" | "review_due" | "delivery_due";
  at: string;
}

/** A scope-aware list widget: in "mine" scope `moreInBusiness` counts the rest of the business (footer "N more in Whole business →"). */
export interface DashboardScopedList<T> {
  items: T[];
  total: number;
  moreInBusiness: number;
}

/** Median turnaround, last 30 days vs the previous 30 (`turnaround` widget, analytics.view only). */
export interface TurnaroundSummary {
  /** Shoot date → delivered (or completed when never delivered), seconds. */
  shootToDelivered: { current: number | null; previous: number | null; count: number };
  /** Submitted → the review decision (approved / revision), seconds. */
  submittedToReviewed: { current: number | null; previous: number | null; count: number };
}

/** `GET /api/dashboard`. Lists are already scoped to the viewer. */
export interface DashboardData {
  /** "business" = an admin / ⚑all member in the Whole business scope; else "personal" (docs/ROLES.md §9). */
  variant: "business" | "personal";
  /** The resolved view scope (null = the viewer has no scope switch). */
  scope: ViewScope | null;
  kpis: KpiSummary;
  /** null when the viewer may not see team workloads. */
  workloads: WorkloadRow[] | null;
  bottlenecks: BottleneckAlert[];
  recentActivity: ActivityFeedItem[];
  dueToday: JobRow[];
  overdue: JobRow[];
  recentCompleted: JobRow[];
  /** This month (org tz) over the viewer's scope; revisionRate 0..1, onTimePercent 0..100. */
  rates: { completedThisMonth: number; revisionRate: number | null; onTimePercent: number | null };
  /** Editor leaderboard for this month (performance.view only). */
  editorPerformance: PerformanceRow[] | null;
  personal: DashboardPersonal | null;
  /** Active jobs where the viewer is the photographer (always "mine"; [] for editors). */
  myShoots: JobRow[];
  /** REVIEWER_HOLDS jobs the viewer may review, oldest first (null: no review permission). */
  awaitingReview: DashboardScopedList<JobRow> | null;
  /** Open editor questions + waiting client feedback on jobs the viewer steers (null for editors). */
  questions: DashboardScopedList<DashboardQuestion> | null;
  upcomingDeadlines: DashboardDeadline[];
  /** Open revisions and resubmissions (editors: revisions to address). */
  revisions: JobRow[];
  /** null without analytics.view. */
  turnaround: TurnaroundSummary | null;
  layout: import("@/db/schema").DashboardLayout;
  asOf: string;
}

export type ReportCell = string | number | boolean | null;

export interface ReportColumn {
  key: string;
  label: string;
  /** hours = number of hours (2 dp); percent = 0..100 (1 dp); date = ISO instant. */
  kind: "text" | "number" | "hours" | "percent" | "date";
  /** date columns only: a calendar deadline — CSV writes the org-local civil date instead of date + time. */
  civil?: boolean;
}

export interface Report {
  kind: import("./constants").ReportKind;
  title: string;
  range: ResolvedRange;
  generatedAt: string;
  columns: ReportColumn[];
  rows: Record<string, ReportCell>[];
  totals: Record<string, ReportCell> | null;
}

/** Job counts per client / project / person (visible jobs only for P/E). */
export interface JobCounts {
  total: number;
  open: number;
  overdue: number;
  dueToday: number;
  completed: number;
  completedThisMonth: number;
  /** Most recent `jobs.last_activity_at` among the counted jobs (null when none). */
  lastActivityAt?: string | null;
  /** Earliest due date among open, deadline-bound jobs (null when none). */
  nextDueDate?: string | null;
}

export interface ClientListItem {
  /** Editors get `contactName`, `email`, `phone` = null (docs/ROLES.md §2.4). */
  client: Pick<
    Client,
    "id" | "name" | "contactName" | "email" | "phone" | "colour" | "archivedAt" | "createdByUserId" | "createdAt" | "version" | "portalEnabled" | "feedbackEnabled"
  >;
  projectCount: number;
  counts: JobCounts;
}

export interface ProjectListItem {
  project: Pick<
    Project,
    "id" | "name" | "clientId" | "address" | "startDate" | "endDate" | "archivedAt" | "createdByUserId" | "createdAt" | "version" | "sharedWithClient"
  >;
  client: ClientRef;
  counts: JobCounts;
}

export interface ClientDetail extends ClientListItem {
  notes: string | null;
  createdBy: UserRef | null;
  projects: ProjectListItem[];
  jobs: JobRow[];
}

export interface ProjectDetail extends ProjectListItem {
  description: string | null;
  createdBy: UserRef | null;
  jobs: JobRow[];
}

export interface TeamRef {
  id: string;
  name: string;
}

export interface DirectoryStats {
  active: number;
  dueToday: number;
  overdue: number;
  /** null without analytics (docs/ROLES.md §10.2: admins and ⚑analytics members only). */
  completedThisMonth: number | null;
  /** 0..1 over the last 30 days; null when nothing was approved (or without analytics, §10.2). */
  revisionRate: number | null;
}

/** `/team/photographers`, `/team/editors` rows. email/title are null in the reduced projection. */
export interface DirectoryEntry {
  user: UserRef;
  email: string | null;
  title: string | null;
  teams: TeamRef[];
  /** null without workloads.view_team (except the viewer's own row). */
  stats: DirectoryStats | null;
}

/** `/team/users/[id]` and `/settings/users/[id]`. */
export interface UserDetailView {
  ref: UserRef;
  /** Full safe row for management and self; null in the reduced projection. */
  profile: UserProfile | null;
  teams: TeamRef[];
  /** Resolved capacity (null in the reduced projection). */
  capacityHoursPerWeek: number | null;
  openJobCount: number | null;
  workload: WorkloadDetail | null;
  canManage: boolean;
}

export interface TeamMembershipView {
  id: string;
  user: UserRef;
  joinedAt: string;
  leftAt: string | null;
  addedBy: UserRef | null;
  removedBy: UserRef | null;
}

export interface TeamView {
  id: string;
  name: string;
  description: string | null;
  lead: UserRef | null;
  archivedAt: string | null;
  version: number;
  members: UserRef[];
  memberCount: number;
}

export interface TeamDetail extends TeamView {
  /** Full membership ledger (team.manage only; [] otherwise). */
  memberships: TeamMembershipView[];
}

export interface SettingsView {
  organisation: { id: string; name: string; slug: string };
  settings: OrganisationSettings;
  canManage: boolean;
}

export interface NotificationPrefView {
  type: NotificationType;
  label: string;
  mandatory: boolean;
  enabled: boolean;
}

export interface JobTypeView {
  id: string;
  name: string;
  colour: string;
  workflow: { id: string; name: string };
  defaultEstimatedHours: number | null;
  sortOrder: number;
  archivedAt: string | null;
  version: number;
  openJobCount: number;
}

export interface WorkflowListItem {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  archivedAt: string | null;
  version: number;
  statusCount: number;
  openJobCount: number;
  jobTypes: JobTypeRef[];
}

export interface WorkflowStatusView extends StatusRef {
  isInitial: boolean;
  description: string | null;
  archivedAt: string | null;
  version: number;
  /** Jobs currently in this status. */
  jobCount: number;
}

export interface WorkflowTransitionView {
  id: string;
  fromStatusId: string;
  toStatusId: string;
  label: string | null;
  allowedRoles: TransitionRole[];
  requiresAssignedEditor: boolean;
  assigneeOnly: boolean;
  isReopen: boolean;
  archivedAt: string | null;
  /** true for engine-generated cancel edges not stored in workflow_transitions. */
  generated: boolean;
}

export interface WorkflowGraph {
  workflow: WorkflowListItem;
  statuses: WorkflowStatusView[];
  transitions: WorkflowTransitionView[];
  /** validateWorkflowDefinition() messages (empty = valid). */
  validation: string[];
}

export interface AutomationRunCounts {
  total: number;
  pending: number;
  matched: number;
  skipped: number;
  succeeded: number;
  failed: number;
}

export interface AutomationListItem {
  id: string;
  name: string;
  description: string | null;
  isEnabled: boolean;
  triggerType: Automation["triggerType"];
  trigger: import("@/db/schema").AutomationTrigger;
  conditions: import("@/db/schema").AutomationCondition[];
  actions: import("@/db/schema").AutomationAction[];
  sortOrder: number;
  archivedAt: string | null;
  version: number;
  createdBy: UserRef | null;
  createdAt: string;
  updatedAt: string;
  runCounts: AutomationRunCounts;
  lastRunAt: string | null;
}

export interface AutomationRunView {
  id: string;
  automation: { id: string; name: string };
  job: JobRef | null;
  triggerEventId: string;
  triggerEventType: string | null;
  depth: number;
  status: AutomationRun["status"];
  conditionsSnapshot: import("@/db/schema").AutomationCondition[];
  actionsPerformed: import("@/db/schema").AutomationActionResult[];
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AutomationDetail extends AutomationListItem {
  recentRuns: AutomationRunView[];
}

export interface SavedViewItem {
  id: string;
  name: string;
  scope: SavedView["scope"];
  config: import("@/db/schema").SavedViewConfig;
  isShared: boolean;
  isDefault: boolean;
  owner: UserRef;
  isMine: boolean;
  archivedAt: string | null;
  version: number;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/*  Part 4 — automations engine (dry run)                              */
/* ------------------------------------------------------------------ */

/** `POST /api/automations/:id/dry-run { jobId }` — what the rule would do to this job, without writing. */
export interface AutomationDryRunResult {
  automationId: string;
  job: JobRef;
  trigger: {
    type: import("@/lib/constants").AutomationTriggerType;
    /** null = no event on this job to test the trigger against. */
    matched: boolean | null;
    eventId: string | null;
    detail: string;
  };
  conditions: { condition: import("@/db/schema").AutomationCondition; met: boolean; detail: string }[];
  conditionsMet: boolean;
  /** Why the rule would not run at all (kill switch / disabled / archived); null = it would. */
  blockedBy: string | null;
  /** Trigger not refuted, conditions met and not blocked. */
  wouldRun: boolean;
  actions: { action: import("@/db/schema").AutomationAction; description: string; problem: string | null }[];
}

/* ------------------------------------------------------------------ */
/*  Picker options + kanban drop (REST API extras, src/app/api/README.md) */
/* ------------------------------------------------------------------ */

/** `GET /api/users/options` — lightweight person picker row (assign dialogs, @mentions). */
export interface UserOption extends UserRef {
  /** Editors only, and only when the actor may view team workloads (else null). */
  workload: { band: WorkloadBand; active: number; overdue: number } | null;
}

/** `GET /api/clients/options`. */
export interface ClientOption {
  id: string;
  name: string;
  colour: string;
}

/** `GET /api/projects/options?clientId=`. */
export interface ProjectOption {
  id: string;
  name: string;
  clientId: string;
  clientName: string;
}

/** A candidate move offered by the kanban drop (ambiguous column or follow-up dialog). */
export interface KanbanMoveOption {
  toStatus: StatusRef;
  label: string;
  isReopen: boolean;
  requiresRevisionPayload: boolean;
  requiresReason: boolean;
}

/** `POST /api/kanban/drop` response (a "none" outcome is a 422 invalid_transition instead). */
export type KanbanDropResponse =
  | { kind: "noop" }
  | { kind: "ambiguous"; candidates: KanbanMoveOption[] }
  | { kind: "needs_revision_payload"; move: KanbanMoveOption }
  | { kind: "needs_reason"; move: KanbanMoveOption }
  | { kind: "moved"; job: Job; fromStatus: StatusRef; toStatus: StatusRef; warnings: string[] };

/** `POST /api/jobs/:id/timer` response. */
export interface TimerActionResult {
  action: "start" | "pause" | "stop";
  session: WorkSession;
  /** start: the timer was already running on this job (no new session). */
  alreadyRunning: boolean;
  /** start with `switchFromRunning`: the session that was stopped on another job. */
  stopped: WorkSession | null;
}

/* ------------------------------------------------------------------ */
/*  Team pages — a person's finished work in a range                    */
/* ------------------------------------------------------------------ */

/** One finished job on `/team/users/[id]` ("what did they work on"). */
export interface CompletedWorkItem {
  job: JobRow;
  approvedAt: string | null;
  completedAt: string | null;
  /** approvedAt <= dueDateAtApproval; null when there was no due date. */
  wasOnTime: boolean | null;
}

/** `getUserCompletedWork()` — finished jobs in range + completions per week (last 8 weeks). */
export interface UserCompletedWork {
  range: ResolvedRange;
  items: CompletedWorkItem[];
  /** Oldest → newest; `week` = civil start date of the 7-day bucket. */
  weekly: { week: string; completed: number; onTime: number; late: number }[];
}
