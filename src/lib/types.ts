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

/** Signed into the jose cookie: user id + session version only. */
export interface SessionPayload {
  sub: string;
  sv: number;
}

/** Visibility flags copied from organisation_settings at request time. */
export interface ContextSettings {
  timezone: string;
  timeTrackingEnabled: boolean;
  photographersSeeAllJobs: boolean;
  photographersSeeTeamJobs: boolean;
  editorsSeeTeamJobs: boolean;
  editorsSeeTeamWorkloads: boolean;
  automationsEnabled: boolean;
}

/**
 * Resolved per request from the cookie + a fresh users row (never cached
 * across requests). `systemContext(orgId)` builds the variant used by the
 * automation runner and the overdue sweep.
 */
export interface AuthContext {
  userId: string | null;
  organisationId: string;
  role: Role;
  isActive: boolean;
  canViewTeamWorkloads: boolean;
  canViewAnalytics: boolean;
  /** Active teammates' user ids (users sharing an active team with the actor). */
  teamUserIds: ReadonlySet<string>;
  settings: ContextSettings;
  /** true only for the system context (automations / sweep / seed). */
  isSystem: boolean;
  /** Injectable clock (seed/tests override). */
  now: () => string;
  /** Request correlation id written into event metadata. */
  requestId: string;
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

/** Ownership/visibility facts the permission layer needs about a job. */
export interface JobPermissionRef {
  id: string;
  organisationId: string;
  photographerId: string | null;
  editorId: string | null;
  createdByUserId: string;
  statusCategory: StatusCategory;
  isPaused: boolean;
  /** Loaded only for editors: every editor who ever held the job. */
  pastEditorIds?: readonly string[];
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
  job: JobRef & { priority: Priority; dueDate: string | null; editor: UserRef | null; photographer: UserRef | null; statusCategory: StatusCategory };
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
  jobs: (JobRef & { status: StatusRef; client: ClientRef; matchedIn: "number" | "name" | "note" | "comment" | "description" })[];
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
    code: "validation" | "unauthorized" | "forbidden" | "not_found" | "conflict" | "invalid_transition" | "rate_limited" | "internal";
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
export interface PermissionMatrixRow {
  action: Action;
  label: string;
  cells: Record<Role, { allowed: boolean; scope: string }>;
}

export type { Action, KpiBucket };
