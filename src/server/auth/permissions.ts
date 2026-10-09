/**
 * Permission policy (ARCHITECTURE.md §3).
 *
 * - `PERMISSIONS` (src/lib/constants.ts) says which roles can EVER perform an
 *   action; `POLICY` below adds the scope rules (own / assigned / past / team /
 *   all / self). `POLICY` is typed against every `Action`, so adding an action
 *   to `PERMISSIONS` without a rule here is a compile error.
 * - Hard rules run before any rule: inactive actor → deny; resource in another
 *   organisation → deny; system context → only `SYSTEM_ACTION_ALLOWLIST`.
 * - Rules are pure functions over `AuthContext` + a resource ref, so they are
 *   unit-testable without a DB. `visibleJobsWhere(ctx)` is the SQL twin of the
 *   `job.view` rule and is the single row-level predicate every list starts from.
 */
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { jobAssignments, jobs } from "@/db/schema";
import {
  ACTIONS,
  CATEGORY_GROUPS,
  COMMENT_EDIT_WINDOW_MINUTES,
  EDITOR_LINK_KINDS,
  PERMISSIONS,
  ROLES,
  type Action,
  type LinkKind,
  type NoteKind,
  type Role,
} from "@/lib/constants";
import type { AuthContext, JobPermissionRef, PermissionMatrixRow } from "@/lib/types";
import { ForbiddenError } from "@/server/errors";

/* ------------------------------------------------------------------ */
/*  Resource refs                                                      */
/* ------------------------------------------------------------------ */

/** Target user of a user-management action. `nextRole` is the requested role for change_role / invite. */
export interface UserPermissionRef {
  id: string;
  role: Role;
  isActive: boolean;
  organisationId: string;
  nextRole?: Role;
}

/** A link on a job. `kind` is the kind being added (link.add) or the row's kind. */
export interface LinkPermissionRef {
  job: JobPermissionRef;
  kind?: LinkKind;
  /** Required for link.replace / link.remove scoped checks (editor: own links only). */
  addedByUserId?: string;
}

/** A note on a job (or the kind of note about to be added). */
export interface NotePermissionRef {
  job: JobPermissionRef;
  kind?: NoteKind;
  /** Author of an existing note (editors may only edit/archive their own). */
  authorUserId?: string;
}

/** An existing comment. */
export interface CommentPermissionRef {
  job: JobPermissionRef;
  authorUserId: string;
  createdAt: string;
  deletedAt?: string | null;
}

/** Client / project rows. */
export interface OrgResourceRef {
  organisationId: string;
  createdByUserId?: string;
  /** Editors only see clients/projects of jobs visible to them; the loader sets this. */
  hasVisibleJob?: boolean;
}

/** Per-user resources (notifications, prefs, saved views, dashboard layouts). */
export interface SelfRef {
  userId: string;
  organisationId?: string;
}

type JobAction =
  | "job.view"
  | "job.view_history"
  | "job.edit_fields"
  | "job.edit_completion_percent"
  | "job.set_due_date"
  | "job.set_review_due_date"
  | "job.set_delivery_due_date"
  | "job.set_priority"
  | "job.assign_photographer"
  | "job.assign_editor"
  | "job.transition"
  | "job.transition_override"
  | "job.accept"
  | "job.decline"
  | "job.start"
  | "job.pause"
  | "job.submit"
  | "job.begin_review"
  | "job.approve"
  | "job.deliver"
  | "job.complete"
  | "job.cancel"
  | "job.reopen"
  | "job.restore"
  | "job.migrate_workflow"
  | "revision.request"
  | "revision.withdraw"
  | "revision.resolve"
  | "comment.add"
  | "comment.mention"
  | "timer.use"
  | "timer.view_others";
type LinkAction = "link.add" | "link.replace" | "link.remove";
type NoteAction = "note.read" | "note.add" | "note.edit" | "note.archive";
type CommentAuthoredAction = "comment.edit" | "comment.delete";
type OrgResourceAction =
  | "client.view"
  | "client.edit"
  | "client.archive"
  | "project.view"
  | "project.edit"
  | "project.archive";
type UserTargetAction =
  | "user.view"
  | "user.invite"
  | "user.edit"
  | "user.change_role"
  | "user.deactivate"
  | "user.reactivate"
  | "user.set_capacity"
  | "user.set_visibility_flags"
  | "user.reset_password"
  | "user.anonymise";
type SelfAction = "notification.read" | "notification.prefs" | "saved_view.manage" | "dashboard.customise";

/** Resource type each action is checked against (`undefined` = no resource). */
export type ResourceOf<A extends Action> = A extends JobAction
  ? JobPermissionRef
  : A extends LinkAction
    ? LinkPermissionRef
    : A extends NoteAction
      ? NotePermissionRef
      : A extends CommentAuthoredAction
        ? CommentPermissionRef
        : A extends OrgResourceAction
          ? OrgResourceRef
          : A extends UserTargetAction
            ? UserPermissionRef
            : A extends SelfAction
              ? SelfRef
              : undefined;

/* ------------------------------------------------------------------ */
/*  Rule shape                                                         */
/* ------------------------------------------------------------------ */

export interface Rule<R> {
  /** Label on the Roles page. */
  label: string;
  /**
   * Scope note per role for the Roles page ("any", "own jobs only", …).
   * Keys must equal PERMISSIONS[action] (asserted by the test-suite).
   */
  scope: Partial<Record<Role, string>>;
  /**
   * Scope check. Only called for roles listed in PERMISSIONS[action], after the
   * hard rules. `resource` may be undefined for page-level checks: scoped rules
   * then deny unless the role's scope is "any".
   */
  allow: (ctx: AuthContext, resource: R | undefined) => boolean;
}

type PolicyTable = { [A in Action]: Rule<ResourceOf<A>> };

/* ------------------------------------------------------------------ */
/*  Scope predicates (pure)                                            */
/* ------------------------------------------------------------------ */

export function isManagement(ctx: Pick<AuthContext, "role">): boolean {
  return ctx.role === "owner" || ctx.role === "manager";
}

/** own: the actor is the job's photographer or its creator. */
export function isOwnJob(ctx: Pick<AuthContext, "userId">, job: JobPermissionRef): boolean {
  return ctx.userId !== null && (job.photographerId === ctx.userId || job.createdByUserId === ctx.userId);
}

/** assigned: the actor is the job's current editor. */
export function isAssignedJob(ctx: Pick<AuthContext, "userId">, job: JobPermissionRef): boolean {
  return ctx.userId !== null && job.editorId === ctx.userId;
}

/** past: the actor held the editor role on the job at some point (read-only). */
export function isPastJob(ctx: Pick<AuthContext, "userId">, job: JobPermissionRef): boolean {
  return ctx.userId !== null && (job.pastEditorIds ?? []).includes(ctx.userId);
}

/** team: the job's photographer or editor is an active teammate (flag-gated per role). */
export function isTeamJob(ctx: AuthContext, job: JobPermissionRef): boolean {
  const gate =
    ctx.role === "photographer"
      ? ctx.settings.photographersSeeTeamJobs
      : ctx.role === "editor"
        ? ctx.settings.editorsSeeTeamJobs
        : true;
  if (!gate) return false;
  return (
    (job.photographerId !== null && ctx.teamUserIds.has(job.photographerId)) ||
    (job.editorId !== null && ctx.teamUserIds.has(job.editorId))
  );
}

/** The `job.view` rule (also the base of every job-scoped read). */
export function canViewJob(ctx: AuthContext, job: JobPermissionRef): boolean {
  if (ctx.isSystem || isManagement(ctx)) return true;
  if (ctx.role === "photographer") {
    return ctx.settings.photographersSeeAllJobs || isOwnJob(ctx, job) || isTeamJob(ctx, job);
  }
  return isAssignedJob(ctx, job) || isPastJob(ctx, job) || isTeamJob(ctx, job);
}

const PHOTOGRAPHER_NOTE_KINDS: readonly NoteKind[] = ["photographer", "client", "revision"];
const EDITOR_NOTE_KINDS: readonly NoteKind[] = ["editor", "revision"];
const EDITOR_WORKING = CATEGORY_GROUPS.EDITOR_WORKING;
const ACTIVE = CATEGORY_GROUPS.ACTIVE;
const PE_ROLES: readonly Role[] = ["photographer", "editor"];

/* ------------------------------------------------------------------ */
/*  Rule builders                                                      */
/* ------------------------------------------------------------------ */

const ANY = "any";
const OM = { owner: ANY, manager: ANY } as const;
const OMPE = { owner: ANY, manager: ANY, photographer: ANY, editor: ANY } as const;
const SELF = { owner: "self", manager: "self", photographer: "self", editor: "self" } as const;

function roleOnly<R>(label: string, scope: Partial<Record<Role, string>>): Rule<R> {
  return { label, scope, allow: () => true };
}

/** O/M any; photographer own. */
function ownJobRule(label: string): Rule<JobPermissionRef> {
  return {
    label,
    scope: { ...OM, photographer: "own jobs" },
    allow: (ctx, job) => isManagement(ctx) || (job !== undefined && isOwnJob(ctx, job)),
  };
}

/** O/M on behalf; editor only when assigned. */
function editorSideRule(label: string): Rule<JobPermissionRef> {
  return {
    label,
    scope: { owner: "any (on behalf of the editor)", manager: "any (on behalf of the editor)", editor: "assigned jobs" },
    allow: (ctx, job) => isManagement(ctx) || (job !== undefined && isAssignedJob(ctx, job)),
  };
}

/** Owner any; manager only photographer/editor targets; optionally self for P/E. */
function userAdminRule(label: string, selfForPE: boolean): Rule<UserPermissionRef> {
  const scope: Partial<Record<Role, string>> = { owner: ANY, manager: "photographers and editors" };
  if (selfForPE) {
    scope.photographer = "self";
    scope.editor = "self";
  }
  return {
    label,
    scope,
    allow: (ctx, target) => {
      if (ctx.role === "owner") return true;
      if (ctx.role === "manager") return target === undefined || PE_ROLES.includes(target.role);
      return selfForPE && target !== undefined && target.id === ctx.userId;
    },
  };
}

function selfRule(label: string): Rule<SelfRef> {
  return { label, scope: SELF, allow: (ctx, r) => r === undefined || r.userId === ctx.userId };
}

function noteWriteRule(label: string, editorOwnOnly: boolean): Rule<NotePermissionRef> {
  return {
    label,
    scope: {
      ...OM,
      photographer: "own jobs; photographer/client/revision notes",
      editor: editorOwnOnly ? "assigned jobs; own editor/revision notes" : "assigned jobs; editor/revision notes",
    },
    allow: (ctx, note) => {
      if (isManagement(ctx)) return true;
      if (!note) return false;
      if (ctx.role === "photographer") {
        return isOwnJob(ctx, note.job) && (note.kind === undefined || PHOTOGRAPHER_NOTE_KINDS.includes(note.kind));
      }
      if (!isAssignedJob(ctx, note.job)) return false;
      if (note.kind !== undefined && !EDITOR_NOTE_KINDS.includes(note.kind)) return false;
      if (editorOwnOnly) return note.authorUserId !== undefined && note.authorUserId === ctx.userId;
      return true;
    },
  };
}

function orgResourceEditRule(label: string): Rule<OrgResourceRef> {
  return {
    label,
    scope: { ...OM, photographer: "created by self" },
    allow: (ctx, r) => isManagement(ctx) || (r !== undefined && r.createdByUserId === ctx.userId),
  };
}

function orgResourceViewRule(label: string): Rule<OrgResourceRef> {
  return {
    label,
    scope: { ...OM, photographer: ANY, editor: "those of visible jobs" },
    allow: (ctx, r) => ctx.role !== "editor" || r === undefined || r.hasVisibleJob !== false,
  };
}

/* ------------------------------------------------------------------ */
/*  POLICY                                                             */
/* ------------------------------------------------------------------ */

export const POLICY = {
  "job.create": {
    label: "Create jobs",
    scope: { ...OM, photographer: "any (defaults to self as photographer)" },
    allow: () => true,
  },
  "job.view": {
    label: "View jobs",
    scope: { ...OM, photographer: "own ∨ team ∨ all (org flags)", editor: "assigned ∨ past ∨ team (org flag)" },
    allow: (ctx, job) => isManagement(ctx) || (job !== undefined && canViewJob(ctx, job)),
  },
  "job.view_history": {
    label: "View job history",
    scope: { ...OM, photographer: "own ∨ team ∨ all (org flags)", editor: "assigned ∨ past ∨ team (org flag)" },
    allow: (ctx, job) => isManagement(ctx) || (job !== undefined && canViewJob(ctx, job)),
  },
  "job.edit_fields": ownJobRule("Edit job fields"),
  "job.edit_completion_percent": {
    label: "Edit completion %",
    scope: { ...OM, photographer: "own jobs", editor: "assigned jobs" },
    allow: (ctx, job) =>
      isManagement(ctx) ||
      (job !== undefined && (ctx.role === "photographer" ? isOwnJob(ctx, job) : isAssignedJob(ctx, job))),
  },
  "job.set_due_date": ownJobRule("Set due date"),
  "job.set_review_due_date": ownJobRule("Set review due date"),
  "job.set_delivery_due_date": ownJobRule("Set delivery due date"),
  "job.set_priority": ownJobRule("Set priority"),
  "job.assign_photographer": {
    label: "Assign photographer",
    scope: { ...OM, photographer: "jobs created by self" },
    allow: (ctx, job) => isManagement(ctx) || (job !== undefined && job.createdByUserId === ctx.userId),
  },
  "job.assign_editor": ownJobRule("Assign / reassign editor"),
  "job.bulk_reassign": roleOnly("Bulk reassign", OM),
  "job.transition": {
    label: "Change status (per workflow edge)",
    scope: { owner: "per edge", manager: "per edge", photographer: "per edge ∧ own jobs", editor: "per edge ∧ assigned jobs" },
    allow: (ctx, job) => {
      if (isManagement(ctx)) return true;
      if (!job) return false;
      return ctx.role === "photographer" ? isOwnJob(ctx, job) : isAssignedJob(ctx, job);
    },
  },
  "job.transition_override": roleOnly("Override status (any → any)", OM),
  "job.accept": editorSideRule("Accept job"),
  "job.decline": {
    label: "Decline job",
    scope: { editor: "assigned jobs in an assigned status" },
    allow: (ctx, job) => job !== undefined && isAssignedJob(ctx, job) && job.statusCategory === "assigned",
  },
  "job.start": editorSideRule("Start work"),
  "job.pause": {
    label: "Pause / resume work",
    scope: {
      owner: "any (on behalf), while editing",
      manager: "any (on behalf), while editing",
      editor: "assigned jobs, while editing",
    },
    allow: (ctx, job) =>
      job !== undefined &&
      EDITOR_WORKING.includes(job.statusCategory) &&
      (isManagement(ctx) || isAssignedJob(ctx, job)),
  },
  "job.submit": editorSideRule("Submit for review"),
  "job.begin_review": ownJobRule("Begin review"),
  "job.approve": ownJobRule("Approve"),
  "job.deliver": ownJobRule("Deliver"),
  "job.complete": ownJobRule("Complete"),
  "job.cancel": {
    label: "Cancel job",
    scope: { owner: "active jobs", manager: "active jobs", photographer: "own active jobs (not completed)" },
    allow: (ctx, job) => {
      if (!job || !ACTIVE.includes(job.statusCategory)) return false;
      if (isManagement(ctx)) return true;
      return isOwnJob(ctx, job) && job.statusCategory !== "completed";
    },
  },
  "job.reopen": ownJobRule("Reopen completed job"),
  "job.restore": ownJobRule("Restore cancelled job"),
  "job.migrate_workflow": roleOnly("Migrate job to another workflow", OM),
  "revision.request": ownJobRule("Request revision"),
  "revision.withdraw": ownJobRule("Withdraw revision"),
  "revision.resolve": editorSideRule("Resolve revision (resubmit)"),
  "link.add": {
    label: "Add links",
    scope: { ...OM, photographer: "own jobs (any kind)", editor: "assigned jobs (editing/finished/gallery/reference/other)" },
    allow: (ctx, link) => {
      if (isManagement(ctx)) return true;
      if (!link) return false;
      if (ctx.role === "photographer") return isOwnJob(ctx, link.job);
      return isAssignedJob(ctx, link.job) && (link.kind === undefined || EDITOR_LINK_KINDS.includes(link.kind));
    },
  },
  "link.replace": linkChangeRule("Replace links"),
  "link.remove": linkChangeRule("Remove links"),
  "note.read": {
    label: "Read notes",
    scope: { ...OM, photographer: "visible jobs (internal: own jobs only)", editor: "visible jobs, not internal" },
    allow: (ctx, note) => {
      if (isManagement(ctx)) return true;
      if (!note || !canViewJob(ctx, note.job)) return false;
      if (note.kind !== "internal") return true;
      return ctx.role === "photographer" && isOwnJob(ctx, note.job);
    },
  },
  "note.add": noteWriteRule("Add notes", false),
  "note.edit": noteWriteRule("Edit notes", true),
  "note.archive": noteWriteRule("Archive notes", true),
  "comment.add": commentWriteRule("Comment"),
  "comment.mention": commentWriteRule("@mention people"),
  "comment.edit": {
    label: "Edit own comments",
    scope: {
      owner: `own, ${COMMENT_EDIT_WINDOW_MINUTES} min`,
      manager: `own, ${COMMENT_EDIT_WINDOW_MINUTES} min`,
      photographer: `own, ${COMMENT_EDIT_WINDOW_MINUTES} min`,
      editor: `own, ${COMMENT_EDIT_WINDOW_MINUTES} min, assigned jobs`,
    },
    allow: (ctx, c) => {
      if (!c || c.deletedAt || c.authorUserId !== ctx.userId) return false;
      if (!isManagement(ctx) && !canWriteCommentsOn(ctx, c.job)) return false;
      const ageMs = Date.parse(ctx.now()) - Date.parse(c.createdAt);
      return Number.isFinite(ageMs) && ageMs <= COMMENT_EDIT_WINDOW_MINUTES * 60_000;
    },
  },
  "comment.delete": {
    label: "Delete comments (soft)",
    scope: { ...OM, photographer: "own comments", editor: "own comments, assigned jobs" },
    allow: (ctx, c) => {
      if (isManagement(ctx)) return true;
      if (!c || c.deletedAt) return false;
      return c.authorUserId === ctx.userId && canWriteCommentsOn(ctx, c.job);
    },
  },
  "timer.use": {
    label: "Use the timer",
    scope: {
      owner: "jobs assigned to self",
      manager: "jobs assigned to self",
      photographer: "own jobs",
      editor: "assigned jobs, while editing",
    },
    allow: (ctx, job) => {
      if (!ctx.settings.timeTrackingEnabled || !job) return false;
      if (ctx.role === "photographer") return isOwnJob(ctx, job);
      if (ctx.role === "editor") return isAssignedJob(ctx, job) && EDITOR_WORKING.includes(job.statusCategory);
      return isAssignedJob(ctx, job);
    },
  },
  "timer.view_others": ownJobRule("View others' time"),
  "analytics.view": analyticsRule("Insights (analytics)"),
  "analytics.view_self": roleOnly("My performance", OMPE),
  "workloads.view_team": {
    label: "Team workloads (aggregates)",
    scope: { ...OM, photographer: "user flag can_view_team_workloads", editor: "org flag editors_see_team_workloads" },
    allow: (ctx) =>
      isManagement(ctx) ||
      (ctx.role === "photographer" ? ctx.canViewTeamWorkloads : ctx.settings.editorsSeeTeamWorkloads),
  },
  "workloads.view_self": roleOnly("My workload", OMPE),
  "performance.view": roleOnly("Performance leaderboards", OM),
  "bottlenecks.view": analyticsRule("Bottlenecks"),
  "reports.view": analyticsRule("Reports"),
  "export.csv": analyticsRule("Export CSV"),
  "team.view_members": roleOnly("Team directory", OMPE),
  "activity.view_global": {
    label: "Global activity feed",
    scope: { ...OM, photographer: "visible jobs", editor: "visible jobs" },
    allow: () => true,
  },
  "activity.view_management_events": roleOnly("Management events in feeds", OM),
  "client.view": orgResourceViewRule("View clients"),
  "client.create": roleOnly("Create clients", { ...OM, photographer: ANY }),
  "client.edit": orgResourceEditRule("Edit clients"),
  "client.archive": roleOnly("Archive clients", OM),
  "project.view": orgResourceViewRule("View projects"),
  "project.create": roleOnly("Create projects", { ...OM, photographer: ANY }),
  "project.edit": orgResourceEditRule("Edit projects"),
  "project.archive": roleOnly("Archive projects", OM),
  "user.view": {
    label: "View users",
    scope: { ...OM, photographer: "reduced projection", editor: "reduced projection" },
    allow: () => true,
  },
  "user.invite": {
    label: "Invite users",
    scope: { owner: ANY, manager: "photographers and editors" },
    allow: (ctx, target) => {
      if (ctx.role === "owner") return true;
      const role = target?.nextRole ?? target?.role;
      return role === undefined || PE_ROLES.includes(role);
    },
  },
  "user.edit": userAdminRule("Edit users", true),
  "user.change_role": {
    label: "Change roles",
    scope: { owner: ANY, manager: "photographer ⇄ editor only" },
    allow: (ctx, target) => {
      if (ctx.role === "owner") return true;
      if (!target) return true;
      return PE_ROLES.includes(target.role) && (target.nextRole === undefined || PE_ROLES.includes(target.nextRole));
    },
  },
  "user.deactivate": {
    label: "Deactivate users",
    scope: { owner: "anyone but self", manager: "photographers and editors" },
    allow: (ctx, target) => {
      if (target && target.id === ctx.userId) return false;
      if (ctx.role === "owner") return true;
      return target === undefined || PE_ROLES.includes(target.role);
    },
  },
  "user.reactivate": userAdminRule("Reactivate users", false),
  "user.set_capacity": userAdminRule("Set capacity", false),
  "user.set_visibility_flags": userAdminRule("Set visibility flags", false),
  "user.reset_password": userAdminRule("Reset passwords", true),
  "user.anonymise": {
    label: "Anonymise deactivated users",
    scope: { owner: "deactivated users" },
    allow: (_ctx, target) => target !== undefined && !target.isActive,
  },
  "team.manage": roleOnly("Manage teams", OM),
  "settings.view": roleOnly("View organisation settings", OM),
  "settings.manage": roleOnly("Manage organisation settings", { owner: ANY }),
  "workflow.view": roleOnly("View workflows", OM),
  "workflow.manage": roleOnly("Manage workflows", { owner: ANY }),
  "job_type.manage": roleOnly("Manage job types", OM),
  "automation.manage": roleOnly("Manage automations", OM),
  "automation.view_runs": roleOnly("View automation runs", OM),
  "notification.read": selfRule("Read notifications"),
  "notification.prefs": selfRule("Notification preferences"),
  "saved_view.manage": selfRule("Manage own saved views"),
  "saved_view.share": roleOnly("Share saved views", OM),
  "dashboard.customise": selfRule("Customise dashboard"),
  "search.global": {
    label: "Global search",
    scope: { ...OM, photographer: "visible jobs", editor: "visible jobs" },
    allow: () => true,
  },
  "system.sweep": roleOnly("Run the overdue sweep", OM),
  "system.integrity": roleOnly("Integrity check / repair", { owner: ANY }),
} satisfies PolicyTable;

function linkChangeRule(label: string): Rule<LinkPermissionRef> {
  return {
    label,
    scope: { ...OM, photographer: "own jobs", editor: "assigned jobs, links added by self" },
    allow: (ctx, link) => {
      if (isManagement(ctx)) return true;
      if (!link) return false;
      if (ctx.role === "photographer") return isOwnJob(ctx, link.job);
      return isAssignedJob(ctx, link.job) && link.addedByUserId !== undefined && link.addedByUserId === ctx.userId;
    },
  };
}

/**
 * Non-management comment write access to a job's thread: photographers on
 * any visible job; editors only while assigned (a past/team job is read-only).
 * Shared by comment.add / comment.mention / comment.edit / comment.delete.
 */
function canWriteCommentsOn(ctx: AuthContext, job: JobPermissionRef): boolean {
  return ctx.role === "photographer" ? canViewJob(ctx, job) : isAssignedJob(ctx, job);
}

function commentWriteRule(label: string): Rule<JobPermissionRef> {
  return {
    label,
    scope: { ...OM, photographer: "visible jobs", editor: "assigned jobs (past: read-only)" },
    allow: (ctx, job) => {
      if (isManagement(ctx)) return true;
      if (!job) return false;
      return canWriteCommentsOn(ctx, job);
    },
  };
}

function analyticsRule(label: string): Rule<undefined> {
  return {
    label,
    scope: { ...OM, photographer: "user flag can_view_analytics" },
    allow: (ctx) => isManagement(ctx) || ctx.canViewAnalytics,
  };
}

/* ------------------------------------------------------------------ */
/*  Hard rules + entry points                                          */
/* ------------------------------------------------------------------ */

/**
 * Actions the system context (automations, sweep, seed) may perform: the
 * automation action allowlist (§7). `notify` has no Action key — sending a
 * notification is not permission-checked; `job.view` is needed to load jobs.
 */
export const SYSTEM_ACTION_ALLOWLIST: ReadonlySet<Action> = new Set<Action>([
  "job.view",
  "job.assign_editor",
  "job.transition",
  "job.set_priority",
  "note.add",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Organisation the resource belongs to (direct, or through its job). */
function resourceOrganisationId(resource: unknown): string | undefined {
  if (!isRecord(resource)) return undefined;
  if (typeof resource.organisationId === "string") return resource.organisationId;
  const job = resource.job;
  if (isRecord(job) && typeof job.organisationId === "string") return job.organisationId;
  return undefined;
}

/** True when the role can ever perform the action (scope rules still apply). */
export function roleCanEver(role: Role, action: Action): boolean {
  return (PERMISSIONS[action] as readonly Role[]).includes(role);
}

export function can<A extends Action>(ctx: AuthContext, action: A, resource?: ResourceOf<A>): boolean {
  if (!ctx.isActive) return false;
  const orgId = resourceOrganisationId(resource);
  if (orgId !== undefined && orgId !== ctx.organisationId) return false;
  if (ctx.isSystem) return SYSTEM_ACTION_ALLOWLIST.has(action);
  if (ctx.userId === null) return false;
  if (!roleCanEver(ctx.role, action)) return false;
  const table: PolicyTable = POLICY;
  const rule: Rule<ResourceOf<A>> = table[action];
  return rule.allow(ctx, resource);
}

export function assertCan<A extends Action>(ctx: AuthContext, action: A, resource?: ResourceOf<A>): void {
  if (!can(ctx, action, resource)) throw new ForbiddenError(action);
}

export function canSeeManagementEvents(ctx: AuthContext): boolean {
  return can(ctx, "activity.view_management_events");
}

/* ------------------------------------------------------------------ */
/*  SQL twin of job.view                                               */
/* ------------------------------------------------------------------ */

const DENY_ALL: SQL = sql`1 = 0`;

function teamClause(ctx: AuthContext): SQL | undefined {
  const ids = [...ctx.teamUserIds];
  if (ids.length === 0) return undefined;
  const list = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  return or(sql`${jobs.photographerId} in (${list})`, sql`${jobs.editorId} in (${list})`);
}

/**
 * Row-level predicate over `jobs` implementing §3.1 scopes. Always includes
 * the organisation filter. Use as `.where(and(visibleJobsWhere(ctx), …))`.
 */
export function visibleJobsWhere(ctx: AuthContext): SQL {
  const inOrg = eq(jobs.organisationId, ctx.organisationId);
  if (!ctx.isActive) return and(inOrg, DENY_ALL) as SQL;
  if (ctx.isSystem || isManagement(ctx)) return inOrg;
  const me = ctx.userId;
  if (me === null) return and(inOrg, DENY_ALL) as SQL;

  const scopes: SQL[] = [];
  if (ctx.role === "photographer") {
    if (ctx.settings.photographersSeeAllJobs) return inOrg;
    scopes.push(eq(jobs.photographerId, me), eq(jobs.createdByUserId, me));
    if (ctx.settings.photographersSeeTeamJobs) {
      const team = teamClause(ctx);
      if (team) scopes.push(team);
    }
  } else {
    scopes.push(eq(jobs.editorId, me));
    scopes.push(
      sql`exists (select 1 from ${jobAssignments} where ${jobAssignments.jobId} = ${jobs.id} and ${jobAssignments.userId} = ${me} and ${jobAssignments.role} = 'editor')`,
    );
    if (ctx.settings.editorsSeeTeamJobs) {
      const team = teamClause(ctx);
      if (team) scopes.push(team);
    }
  }
  return and(inOrg, or(...scopes)) as SQL;
}

/* ------------------------------------------------------------------ */
/*  Roles page                                                         */
/* ------------------------------------------------------------------ */

export function permissionMatrix(): PermissionMatrixRow[] {
  return ACTIONS.map((action) => {
    const rule: { label: string; scope: Partial<Record<Role, string>> } = POLICY[action];
    const cells = {} as PermissionMatrixRow["cells"];
    for (const role of ROLES) {
      const allowed = roleCanEver(role, action);
      cells[role] = { allowed, scope: allowed ? (rule.scope[role] ?? ANY) : "never" };
    }
    return { action, label: rule.label, cells };
  });
}
