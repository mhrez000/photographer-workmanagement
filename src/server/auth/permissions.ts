/**
 * Permission policy — roles v2 (docs/ROLES.md §2, §3; supersedes ARCHITECTURE.md §3).
 *
 * - Three roles (photographer, editor, client); the PERSONA (admin / member /
 *   editor / client) is derived: admin = photographer ∧ is_admin. `PERMISSIONS`
 *   (src/lib/constants.ts) says which personas can EVER perform an action;
 *   `POLICY` below adds the scope rules (managed / controls / assigned / working /
 *   past / created / draft / teamView / visible / shared / self / ⚑flag).
 *   `POLICY` is typed against every `Action`: adding an action without a rule is
 *   a compile error.
 * - Hard rules run before any rule, in order: inactive actor → deny; resource in
 *   another organisation → deny; system context → `SYSTEM_ACTION_ALLOWLIST`;
 *   no user id → deny; persona never allowed → deny; self-review rule; primary-
 *   owner protection; then the rule.
 * - Rules are pure functions over `AuthContext` + a resource ref (unit-testable
 *   without a DB). `visibleJobsWhere(ctx)` is the SQL twin of `job.view` and
 *   `portalJobsWhere(ctx)` the SQL twin of `portal.view_job`.
 */
import { and, eq, gte, ne, or, sql, type SQL } from "drizzle-orm";
import { jobAssignments, jobs, projects } from "@/db/schema";
import {
  ACTIONS,
  CATEGORY_GROUPS,
  COMMENT_EDIT_WINDOW_MINUTES,
  DRAFT_CATEGORIES,
  EDITOR_FLAG_META,
  EDITOR_LINK_KINDS,
  MEMBER_FLAG_META,
  PERMISSIONS,
  PERSONAS,
  PORTAL_CANCELLED_VISIBLE_DAYS,
  PRIMARY_OWNER_PROTECTED_ACTIONS,
  REVIEW_GATED_CATEGORIES,
  SELF_REVIEW_ACTIONS,
  STAFF_ROLES,
  personaMayEver,
  type Action,
  type CommentKind,
  type EditorFlag,
  type LinkKind,
  type MemberFlag,
  type NoteKind,
  type Persona,
  type Role,
  type StatusCategory,
} from "@/lib/constants";
import type { AuthContext, Job, JobPermissionRef, PermissionMatrixRow, PortalJobRef } from "@/lib/types";
import { ForbiddenError } from "@/server/errors";

/* ------------------------------------------------------------------ */
/*  Resource refs                                                      */
/* ------------------------------------------------------------------ */

/** Target user of a user-management action. */
export interface UserPermissionRef {
  id: string;
  role: Role;
  isActive: boolean;
  organisationId: string;
  /** users.is_admin of the target. */
  isAdmin?: boolean;
  /** The target is the organisation's primary owner. */
  isPrimaryOwner?: boolean;
  /** Requested role (user.change_role / user.invite). */
  nextRole?: Role;
  /** Requested admin value (user.set_admin). */
  nextIsAdmin?: boolean;
}

/** A link on a job. `kind` is the kind being added (link.add) or the row's kind. */
export interface LinkPermissionRef {
  job: JobPermissionRef;
  kind?: LinkKind;
  /** Required for link.replace / link.remove (editors: own links only). */
  addedByUserId?: string;
  /** superseded_at IS NULL ∧ removed_at IS NULL (link.share_with_client: current links only). */
  isCurrent?: boolean;
  /** job_links.shared_with_client of the row. */
  sharedWithClient?: boolean;
}

/** A note on a job (or the kind of note about to be added). */
export interface NotePermissionRef {
  job: JobPermissionRef;
  kind?: NoteKind;
  /** Author of an existing note (editors may only edit/archive their own). */
  authorUserId?: string;
}

/** An existing comment. Client cells evaluate `job` as a PortalJobRef. */
export interface CommentPermissionRef {
  job: JobPermissionRef;
  authorUserId: string;
  createdAt: string;
  deletedAt?: string | null;
  kind?: CommentKind;
  /** Kind of the thread's root comment (= kind for roots). */
  rootKind?: CommentKind;
}

/** Client / project rows. */
export interface OrgResourceRef {
  organisationId: string;
  createdByUserId?: string;
  /** Editors only see clients/projects of jobs visible to them; the loader sets this. */
  hasVisibleJob?: boolean;
  /** project.create by an editor: only inline from the New job form (§4.3). */
  inlineFromJobCreate?: boolean;
}

/** Per-user resources (notifications, prefs, saved views, dashboard layouts). */
export interface SelfRef {
  userId: string;
  organisationId?: string;
}

export type { PortalJobRef };

type JobAction =
  | "job.view"
  | "job.view_history"
  | "job.edit_fields"
  | "job.change_client"
  | "job.edit_completion_percent"
  | "job.set_due_date"
  | "job.set_review_due_date"
  | "job.set_delivery_due_date"
  | "job.set_priority"
  | "job.assign_photographer"
  | "job.assign_editor"
  | "job.claim"
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
  | "job.share_with_client"
  | "revision.request"
  | "revision.withdraw"
  | "revision.resolve"
  | "comment.add"
  | "comment.mention"
  | "client_feedback.reply"
  | "client_feedback.to_revision"
  | "timer.use"
  | "timer.view_others";
type LinkAction = "link.add" | "link.replace" | "link.remove" | "link.share_with_client";
type NoteAction = "note.read" | "note.add" | "note.edit" | "note.archive";
type CommentAuthoredAction = "comment.edit" | "comment.delete";
type OrgResourceAction =
  | "client.view"
  | "client.edit"
  | "client.archive"
  | "client.manage_portal"
  | "project.view"
  | "project.create"
  | "project.edit"
  | "project.archive"
  | "project.share_with_client";
type UserTargetAction =
  | "user.view"
  | "user.invite"
  | "user.edit"
  | "user.change_email"
  | "user.change_role"
  | "user.deactivate"
  | "user.reactivate"
  | "user.set_capacity"
  | "user.set_permissions"
  | "user.set_admin"
  | "user.reset_password"
  | "user.anonymise"
  | "org.transfer_primary_owner";
type SelfAction = "notification.read" | "notification.prefs" | "saved_view.manage" | "dashboard.customise";
type PortalAction = "portal.view_job" | "portal.give_feedback";

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
              : A extends PortalAction
                ? PortalJobRef
                : undefined;

/* ------------------------------------------------------------------ */
/*  Rule shape                                                         */
/* ------------------------------------------------------------------ */

export interface Rule<R> {
  /** Label on the Roles page. */
  label: string;
  /** Scope note per persona for the Roles page. Keys must equal PERMISSIONS[action] (test-enforced). */
  scope: Partial<Record<Persona, string>>;
  /** The switch a member needs for this action (Roles page: "needs: …"). */
  memberFlag?: MemberFlag;
  /** The switch an editor needs for this action. */
  editorFlag?: EditorFlag;
  /**
   * Scope check. Only called for personas listed in PERMISSIONS[action], after
   * the hard rules. `resource` may be undefined for page-level checks: scoped
   * rules then deny unless the persona's scope is "any".
   */
  allow: (ctx: AuthContext, resource: R | undefined) => boolean;
}

type PolicyTable = { [A in Action]: Rule<ResourceOf<A>> };

/* ------------------------------------------------------------------ */
/*  Persona + scope predicates (pure)                                  */
/* ------------------------------------------------------------------ */

type Actor = Pick<AuthContext, "userId" | "role" | "isAdmin" | "isSystem">;

/** admin / member / editor / client. The system context is "admin". */
export function personaOf(ctx: Actor): Persona {
  if (ctx.isSystem) return "admin";
  if (ctx.role === "photographer") return ctx.isAdmin ? "admin" : "member";
  return ctx.role;
}

/** Owner / co-owner (or the system context). */
export function isAdmin(ctx: Actor): boolean {
  return ctx.isSystem || (ctx.role === "photographer" && ctx.isAdmin);
}

/**
 * @deprecated roles-v2: there is no management role any more. Port every call site
 * per docs/ROLES.md §2.1 (`isAdmin`, or `hasBusinessView` / `resolveMetricScope` for
 * visibility sites) — never widen. Kept as an `isAdmin` alias only so not-yet-ported
 * code runs with the narrower (safe) meaning.
 */
export const isManagement = isAdmin;

/** Role uses the staff app (photographer or editor). */
export function isStaff(ctx: Pick<AuthContext, "role">): boolean {
  return (STAFF_ROLES as readonly Role[]).includes(ctx.role);
}

export function isClient(ctx: Pick<AuthContext, "role" | "isSystem">): boolean {
  return !ctx.isSystem && ctx.role === "client";
}

/** Effective flag (ctx already holds effective values; admins have every member switch). */
export function hasFlag(ctx: AuthContext, flag: MemberFlag | EditorFlag): boolean {
  return ctx[flag] === true;
}

/** The member created the job as a photographer. */
export function ownsJob(ctx: Pick<AuthContext, "userId" | "role">, job: JobPermissionRef): boolean {
  return ctx.role === "photographer" && ctx.userId !== null && job.createdByUserId === ctx.userId && job.createdByRole === "photographer";
}

/** "Jobs they manage": photographer of the job, or created it as a photographer. PERMISSIONS ONLY — never a view scope. */
export function managesJob(ctx: Pick<AuthContext, "userId" | "role">, job: JobPermissionRef): boolean {
  return ctx.role === "photographer" && ctx.userId !== null && (job.photographerId === ctx.userId || ownsJob(ctx, job));
}

/** The actor may steer the job: admin, created it as a photographer, or manages it ∧ ⚑review (§3.2 "controls"). */
export function controlsJob(ctx: AuthContext, job: JobPermissionRef): boolean {
  return isAdmin(ctx) || ownsJob(ctx, job) || (managesJob(ctx, job) && ctx.canReviewSubmissions);
}

/** assigned: the actor is the job's current editor. */
export function isAssignedJob(ctx: Pick<AuthContext, "userId" | "role">, job: JobPermissionRef): boolean {
  return ctx.role === "editor" && ctx.userId !== null && job.editorId === ctx.userId;
}

/** working: assigned ∧ the editor's work is not frozen (EDITOR_HOLDS). */
export function isWorkingJob(ctx: Pick<AuthContext, "userId" | "role">, job: JobPermissionRef): boolean {
  return isAssignedJob(ctx, job) && CATEGORY_GROUPS.EDITOR_HOLDS.includes(job.statusCategory);
}

/** past: the editor held the job at some point (read-only). */
export function isPastJob(ctx: Pick<AuthContext, "userId" | "role">, job: JobPermissionRef): boolean {
  return ctx.role === "editor" && ctx.userId !== null && (job.pastEditorIds ?? []).includes(ctx.userId);
}

/** created: the editor created the job (read-only outside the draft window). */
export function isCreatedJob(ctx: Pick<AuthContext, "userId" | "role">, job: JobPermissionRef): boolean {
  return ctx.role === "editor" && ctx.userId !== null && job.createdByUserId === ctx.userId;
}

/** Editor's creator draft window (§4.3). */
export function isEditorDraft(ctx: Pick<AuthContext, "userId" | "role">, job: JobPermissionRef): boolean {
  return (
    isCreatedJob(ctx, job) &&
    DRAFT_CATEGORIES.includes(job.statusCategory) &&
    (job.editorId === null || job.editorId === ctx.userId) &&
    !job.draftClosed
  );
}

/** teamView: editor with ⚑teamJobs on a job some editor holds (read-only). */
export function isTeamViewJob(ctx: AuthContext, job: JobPermissionRef): boolean {
  return ctx.role === "editor" && ctx.canViewTeamJobs && job.editorId !== null;
}

/** Admin, or member with ⚑all: may switch to the Whole business view. */
export function hasBusinessView(ctx: AuthContext): boolean {
  return isAdmin(ctx) || (ctx.role === "photographer" && ctx.canViewAllJobs);
}

/** Hard self-review rule (§3.4): I am or was an editor of this job. */
export function workedOnJob(ctx: Pick<AuthContext, "userId">, job: JobPermissionRef): boolean {
  return ctx.userId !== null && (job.editorId === ctx.userId || (job.pastEditorIds ?? []).includes(ctx.userId));
}

/** The `job.view` rule (also the base of every job-scoped read). Clients never: they use the portal. */
export function canViewJob(ctx: AuthContext, job: JobPermissionRef): boolean {
  if (isAdmin(ctx)) return true;
  if (ctx.role === "photographer") return ctx.canViewAllJobs || managesJob(ctx, job);
  if (ctx.role === "editor") return isAssignedJob(ctx, job) || isPastJob(ctx, job) || isCreatedJob(ctx, job) || isTeamViewJob(ctx, job);
  return false;
}

/** Start of the portal's cancelled-job window (ISO), relative to the context clock. */
export function portalCancelledCutoff(ctx: Pick<AuthContext, "now">): string {
  return new Date(Date.parse(ctx.now()) - PORTAL_CANCELLED_VISIBLE_DAYS * 24 * 60 * 60_000).toISOString();
}

/** The `portal.view_job` rule: pure twin of `portalJobsWhere`. */
export function portalCanViewJob(ctx: AuthContext, job: PortalJobRef): boolean {
  if (ctx.role !== "client" || ctx.clientId === null || job.clientId !== ctx.clientId) return false;
  if (!job.sharedWithClient && !job.projectSharedWithClient) return false;
  if (job.statusCategory === "cancelled") {
    return typeof job.cancelledAt === "string" && job.cancelledAt >= portalCancelledCutoff(ctx);
  }
  return true;
}

/* ------------------------------------------------------------------ */
/*  Rule builders                                                      */
/* ------------------------------------------------------------------ */

const ANY = "any";
const EDITOR_WORKING = CATEGORY_GROUPS.EDITOR_WORKING;
const ACTIVE = CATEGORY_GROUPS.ACTIVE;
const MEMBER_NOTE_KINDS: readonly NoteKind[] = ["photographer", "client", "revision"];
const EDITOR_NOTE_KINDS: readonly NoteKind[] = ["editor", "revision"];
const EDITOR_DRAFT_LINK_KINDS: readonly LinkKind[] = [...EDITOR_LINK_KINDS, "raw_files"];
/** Client-facing link kinds (§3.3 †). */
const CLIENT_FACING_LINK_KINDS: readonly LinkKind[] = ["gallery", "client_delivery"];
const isGated = (c: StatusCategory) => REVIEW_GATED_CATEGORIES.includes(c);

function adminOnly<R>(label: string, scope: string = ANY): Rule<R> {
  return { label, scope: { admin: scope }, allow: () => true };
}

/** Admin any; member managed. */
function managedRule(label: string): Rule<JobPermissionRef> {
  return {
    label,
    scope: { admin: ANY, member: "managed jobs" },
    allow: (ctx, job) => isAdmin(ctx) || (job !== undefined && managesJob(ctx, job)),
  };
}

/** Admin any; member managed ∧ ⚑review (reviews, delivery, sharing). */
function reviewRule(label: string): Rule<JobPermissionRef> {
  return {
    label,
    scope: { admin: ANY, member: "managed jobs" },
    memberFlag: "canReviewSubmissions",
    allow: (ctx, job) => isAdmin(ctx) || (job !== undefined && managesJob(ctx, job) && ctx.canReviewSubmissions),
  };
}

/** Admin any; member controls; editor draft (dates, priority, client/project). */
function controlsOrDraftRule(label: string): Rule<JobPermissionRef> {
  return {
    label,
    scope: { admin: ANY, member: "jobs they control", editor: "own draft jobs" },
    allow: (ctx, job) => {
      if (isAdmin(ctx)) return true;
      if (!job) return false;
      return ctx.role === "photographer" ? controlsJob(ctx, job) : isEditorDraft(ctx, job);
    },
  };
}

/** Admin any (on behalf of the editor); editor only when assigned. */
function editorSideRule(label: string): Rule<JobPermissionRef> {
  return {
    label,
    scope: { admin: "any (on behalf of the editor)", editor: "assigned jobs" },
    allow: (ctx, job) => isAdmin(ctx) || (job !== undefined && isAssignedJob(ctx, job)),
  };
}

function selfRule(label: string, withClient: boolean): Rule<SelfRef> {
  const scope: Partial<Record<Persona, string>> = { admin: "self", member: "self", editor: "self" };
  if (withClient) scope.client = "self";
  return { label, scope, allow: (ctx, r) => r === undefined || r.userId === ctx.userId };
}

/** Member link writes need `link.share_with_client` on client-facing / shared links once review-gated (§3.3 †). */
function memberLinkNeedsShare(link: LinkPermissionRef, replacingOrRemoving: boolean): boolean {
  if (!isGated(link.job.statusCategory)) return false;
  if (link.kind !== undefined && CLIENT_FACING_LINK_KINDS.includes(link.kind)) return true;
  return replacingOrRemoving && link.sharedWithClient === true;
}

function linkChangeRule(label: string): Rule<LinkPermissionRef> {
  return {
    label,
    scope: { admin: ANY, member: "managed jobs (client-facing once in review: needs Review submissions)", editor: "own unshared links, while working or in draft" },
    allow: (ctx, link) => {
      if (isAdmin(ctx)) return true;
      if (!link) return false;
      if (ctx.role === "photographer") {
        if (!managesJob(ctx, link.job)) return false;
        return !memberLinkNeedsShare(link, true) || ctx.canReviewSubmissions;
      }
      return (
        (isWorkingJob(ctx, link.job) || isEditorDraft(ctx, link.job)) &&
        link.addedByUserId !== undefined &&
        link.addedByUserId === ctx.userId &&
        link.sharedWithClient !== true
      );
    },
  };
}

function noteWriteRule(label: string, ownOnly: boolean): Rule<NotePermissionRef> {
  return {
    label,
    scope: {
      admin: ANY,
      member: "managed jobs; photographer/client/revision notes (delivery: needs Review submissions)",
      editor: ownOnly ? "assigned or draft jobs; own editor/revision notes" : "assigned or draft jobs; editor/revision notes",
    },
    allow: (ctx, note) => {
      if (isAdmin(ctx)) return true;
      if (!note) return false;
      if (ctx.role === "photographer") {
        if (!managesJob(ctx, note.job)) return false;
        if (note.kind === undefined || MEMBER_NOTE_KINDS.includes(note.kind)) return true;
        return note.kind === "delivery" && ctx.canReviewSubmissions;
      }
      if (!isAssignedJob(ctx, note.job) && !isEditorDraft(ctx, note.job)) return false;
      if (note.kind !== undefined && !EDITOR_NOTE_KINDS.includes(note.kind)) return false;
      if (ownOnly) return note.authorUserId !== undefined && note.authorUserId === ctx.userId;
      return true;
    },
  };
}

/** Staff comment write access to a job's thread: members on visible jobs; editors assigned ∨ draft (§3.3 ‡). */
function canWriteCommentsOn(ctx: AuthContext, job: JobPermissionRef): boolean {
  if (isAdmin(ctx)) return true;
  if (ctx.role === "photographer") return canViewJob(ctx, job);
  if (ctx.role === "editor") return isAssignedJob(ctx, job) || isEditorDraft(ctx, job);
  return false;
}

function commentWriteRule(label: string): Rule<JobPermissionRef> {
  return {
    label,
    scope: { admin: ANY, member: "visible jobs", editor: "assigned or draft jobs (past / team: read-only)" },
    allow: (ctx, job) => job !== undefined && canWriteCommentsOn(ctx, job),
  };
}

function withinEditWindow(ctx: AuthContext, createdAt: string): boolean {
  const ageMs = Date.parse(ctx.now()) - Date.parse(createdAt);
  return Number.isFinite(ageMs) && ageMs <= COMMENT_EDIT_WINDOW_MINUTES * 60_000;
}

/** A client's own client_feedback comment on a job they can see in the portal. */
function ownClientFeedback(ctx: AuthContext, c: CommentPermissionRef): boolean {
  return c.kind === "client_feedback" && c.authorUserId === ctx.userId && portalCanViewJob(ctx, c.job);
}

function analyticsRule(label: string): Rule<undefined> {
  return {
    label,
    scope: { admin: ANY, member: "job-level rows: visible jobs only" },
    memberFlag: "canViewAnalytics",
    allow: (ctx) => isAdmin(ctx) || ctx.canViewAnalytics,
  };
}

function orgResourceViewRule(label: string): Rule<OrgResourceRef> {
  return {
    label,
    scope: { admin: ANY, member: ANY, editor: "of visible jobs; name and colour only" },
    allow: (ctx, r) => ctx.role !== "editor" || r === undefined || r.hasVisibleJob !== false,
  };
}

function orgResourceEditRule(label: string): Rule<OrgResourceRef> {
  return {
    label,
    scope: { admin: ANY, member: "created by self" },
    allow: (ctx, r) => isAdmin(ctx) || (r !== undefined && r.createdByUserId !== undefined && r.createdByUserId === ctx.userId),
  };
}

const STAFF_SCOPE = (note: string) => ({ admin: ANY, member: note, editor: note });

/* ------------------------------------------------------------------ */
/*  POLICY                                                             */
/* ------------------------------------------------------------------ */

export const POLICY = {
  "app.access": { label: "Use the studio app", scope: { admin: ANY, member: ANY, editor: ANY }, allow: () => true },
  "portal.access": { label: "Use the client portal", scope: { client: ANY }, allow: () => true },
  "job.create": {
    label: "Create jobs",
    scope: {
      admin: "any active photographer (default self)",
      member: "photographer = self",
      editor: "photographer required; editor = self or none",
    },
    memberFlag: "canCreateJobs",
    editorFlag: "canCreateJobs",
    allow: (ctx) => isAdmin(ctx) || ctx.canCreateJobs,
  },
  "job.view": {
    label: "View jobs",
    scope: { admin: ANY, member: "managed jobs ∨ all (See all jobs)", editor: "assigned ∨ past ∨ created ∨ other editors' (switch)" },
    allow: (ctx, job) => job !== undefined && canViewJob(ctx, job),
  },
  "job.view_history": {
    label: "View job history",
    scope: { admin: ANY, member: "managed jobs ∨ all (See all jobs)", editor: "assigned ∨ past ∨ created ∨ other editors' (switch)" },
    allow: (ctx, job) => job !== undefined && canViewJob(ctx, job),
  },
  "job.edit_fields": {
    label: "Edit job fields",
    scope: { admin: ANY, member: "managed jobs", editor: "own draft jobs" },
    allow: (ctx, job) => {
      if (isAdmin(ctx)) return true;
      if (!job) return false;
      return ctx.role === "photographer" ? managesJob(ctx, job) : isEditorDraft(ctx, job);
    },
  },
  "job.change_client": controlsOrDraftRule("Change client / project"),
  "job.edit_completion_percent": {
    label: "Edit completion %",
    scope: { admin: ANY, member: "managed jobs", editor: "assigned jobs while working" },
    allow: (ctx, job) => {
      if (isAdmin(ctx)) return true;
      if (!job) return false;
      return ctx.role === "photographer" ? managesJob(ctx, job) : isWorkingJob(ctx, job);
    },
  },
  "job.set_due_date": controlsOrDraftRule("Set due date"),
  "job.set_review_due_date": controlsOrDraftRule("Set review due date"),
  "job.set_delivery_due_date": controlsOrDraftRule("Set delivery due date"),
  "job.set_priority": controlsOrDraftRule("Set priority"),
  "job.assign_photographer": {
    label: "Assign photographer",
    scope: { admin: ANY, editor: "own draft jobs" },
    allow: (ctx, job) => isAdmin(ctx) || (job !== undefined && isEditorDraft(ctx, job)),
  },
  "job.assign_editor": {
    label: "Assign / reassign / unassign editor",
    scope: { admin: ANY, member: "managed jobs" },
    memberFlag: "canAssignEditors",
    allow: (ctx, job) => isAdmin(ctx) || (job !== undefined && managesJob(ctx, job) && ctx.canAssignEditors),
  },
  "job.claim": {
    label: "Take an unassigned job I created",
    scope: { editor: "own draft jobs without an editor (New / Ready)" },
    allow: (ctx, job) =>
      job !== undefined && isEditorDraft(ctx, job) && job.editorId === null && (job.statusCategory === "new" || job.statusCategory === "ready"),
  },
  "job.bulk_reassign": adminOnly("Bulk reassign"),
  "job.transition": {
    label: "Change status (per workflow edge)",
    scope: { admin: "per edge", member: "per edge ∧ managed jobs", editor: "per edge ∧ assigned jobs" },
    allow: (ctx, job) => {
      if (isAdmin(ctx)) return true;
      if (!job) return false;
      return ctx.role === "photographer" ? managesJob(ctx, job) : isAssignedJob(ctx, job);
    },
  },
  "job.transition_override": adminOnly("Override status (any → any)"),
  "job.accept": editorSideRule("Accept job"),
  "job.decline": {
    label: "Decline job",
    scope: { editor: "assigned jobs in an assigned status" },
    allow: (ctx, job) => job !== undefined && isAssignedJob(ctx, job) && job.statusCategory === "assigned",
  },
  "job.start": editorSideRule("Start work"),
  "job.pause": {
    label: "Pause / resume work",
    scope: { admin: "any (on behalf), while editing", editor: "assigned jobs, while editing" },
    allow: (ctx, job) => job !== undefined && EDITOR_WORKING.includes(job.statusCategory) && (isAdmin(ctx) || isAssignedJob(ctx, job)),
  },
  "job.submit": editorSideRule("Submit for review"),
  "job.begin_review": reviewRule("Begin review"),
  "job.approve": reviewRule("Approve"),
  "job.deliver": reviewRule("Deliver"),
  "job.complete": reviewRule("Complete"),
  "job.cancel": {
    label: "Cancel job",
    scope: { admin: "active jobs", member: "active jobs they control (not completed)" },
    allow: (ctx, job) => {
      if (!job || !ACTIVE.includes(job.statusCategory)) return false;
      if (isAdmin(ctx)) return true;
      return controlsJob(ctx, job) && job.statusCategory !== "completed";
    },
  },
  "job.reopen": reviewRule("Reopen completed job"),
  "job.restore": {
    label: "Restore cancelled job",
    scope: { admin: ANY, member: "jobs they control" },
    allow: (ctx, job) => isAdmin(ctx) || (job !== undefined && controlsJob(ctx, job)),
  },
  "job.migrate_workflow": adminOnly("Migrate job to another workflow"),
  "job.share_with_client": reviewRule("Share job with the client"),
  "revision.request": reviewRule("Request revision"),
  "revision.withdraw": reviewRule("Withdraw revision"),
  "revision.resolve": editorSideRule("Resolve revision (resubmit)"),
  "link.add": {
    label: "Add links",
    scope: {
      admin: "any kind",
      member: "managed jobs, any kind (client-facing once in review: needs Review submissions)",
      editor: "working: editing/finished/gallery/reference/other; draft: + raw files",
    },
    allow: (ctx, link) => {
      if (isAdmin(ctx)) return true;
      if (!link) return false;
      if (ctx.role === "photographer") {
        if (!managesJob(ctx, link.job)) return false;
        return !memberLinkNeedsShare(link, false) || ctx.canReviewSubmissions;
      }
      // (working, EDITOR_LINK_KINDS) ∨ (draft, + raw_files): a self-assigned draft job in assigned/accepted is BOTH,
      // so the scopes combine instead of the first match winning (the creator adds the raw source link).
      const kinds = isEditorDraft(ctx, link.job) ? EDITOR_DRAFT_LINK_KINDS : isWorkingJob(ctx, link.job) ? EDITOR_LINK_KINDS : null;
      if (!kinds) return false;
      return link.kind === undefined || kinds.includes(link.kind);
    },
  },
  "link.replace": linkChangeRule("Replace links"),
  "link.remove": linkChangeRule("Remove links"),
  "link.share_with_client": {
    label: "Share a link with the client",
    scope: { admin: "current links", member: "managed jobs, current links" },
    memberFlag: "canReviewSubmissions",
    allow: (ctx, link) => {
      if (!link || link.isCurrent === false) return false;
      return isAdmin(ctx) || (managesJob(ctx, link.job) && ctx.canReviewSubmissions);
    },
  },
  "note.read": {
    label: "Read notes",
    scope: {
      admin: "all kinds",
      member: "visible jobs; internal notes on managed jobs only",
      editor: "visible jobs; never internal or client notes",
    },
    allow: (ctx, note) => {
      if (isAdmin(ctx)) return true;
      if (!note || !canViewJob(ctx, note.job)) return false;
      if (ctx.role === "photographer") return note.kind !== "internal" || managesJob(ctx, note.job);
      return note.kind === undefined || (note.kind !== "internal" && note.kind !== "client");
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
      admin: `own, ${COMMENT_EDIT_WINDOW_MINUTES} min`,
      member: `own, ${COMMENT_EDIT_WINDOW_MINUTES} min`,
      editor: `own, ${COMMENT_EDIT_WINDOW_MINUTES} min, assigned or draft jobs`,
      client: `own feedback, ${COMMENT_EDIT_WINDOW_MINUTES} min, while feedback is on`,
    },
    allow: (ctx, c) => {
      if (!c || c.deletedAt || c.authorUserId !== ctx.userId) return false;
      if (!withinEditWindow(ctx, c.createdAt)) return false;
      if (ctx.role === "client") return ownClientFeedback(ctx, c) && portalCanGiveFeedback(ctx, c.job);
      return canWriteCommentsOn(ctx, c.job);
    },
  },
  "comment.delete": {
    label: "Delete comments (soft)",
    scope: { admin: ANY, member: "own comments", editor: "own comments, assigned or draft jobs", client: "own feedback" },
    allow: (ctx, c) => {
      if (!c || c.deletedAt) return false;
      if (isAdmin(ctx)) return true;
      if (ctx.role === "client") return ownClientFeedback(ctx, c);
      return c.authorUserId === ctx.userId && canWriteCommentsOn(ctx, c.job);
    },
  },
  "client_feedback.reply": reviewRule("Reply to client feedback"),
  "client_feedback.to_revision": reviewRule("Turn client feedback into a revision request"),
  "timer.use": {
    label: "Use the timer",
    scope: { admin: "managed jobs", member: "managed jobs", editor: "assigned jobs, while editing" },
    allow: (ctx, job) => {
      if (!ctx.settings.timeTrackingEnabled || !job) return false;
      if (ctx.role === "photographer") return managesJob(ctx, job);
      return isAssignedJob(ctx, job) && EDITOR_WORKING.includes(job.statusCategory);
    },
  },
  "timer.view_others": managedRule("View others' time"),
  "analytics.view": analyticsRule("Insights (analytics)"),
  "analytics.view_self": { label: "My performance", scope: STAFF_SCOPE(ANY), allow: () => true },
  "workloads.view_team": {
    label: "Team workloads",
    scope: { admin: ANY, member: ANY },
    memberFlag: "canViewTeamWorkloads",
    allow: (ctx) => isAdmin(ctx) || ctx.canViewTeamWorkloads,
  },
  "workloads.view_self": { label: "My workload", scope: STAFF_SCOPE(ANY), allow: () => true },
  "performance.view": analyticsRule("Team performance"),
  "bottlenecks.view": analyticsRule("Bottlenecks"),
  "reports.view": analyticsRule("Reports"),
  "export.csv": analyticsRule("Export CSV"),
  "team.view_members": { label: "Team directory", scope: { admin: ANY, member: ANY }, allow: () => true },
  "activity.view_global": { label: "Global activity feed", scope: STAFF_SCOPE("visible jobs"), allow: () => true },
  "activity.view_management_events": adminOnly("Management events in feeds"),
  "client.view": orgResourceViewRule("View clients"),
  "client.create": {
    label: "Create clients",
    scope: { admin: ANY, member: ANY },
    memberFlag: "canCreateJobs",
    allow: (ctx) => isAdmin(ctx) || ctx.canCreateJobs,
  },
  "client.edit": orgResourceEditRule("Edit clients"),
  "client.archive": adminOnly("Archive clients"),
  "client.manage_portal": adminOnly("Client portal access and users"),
  "project.view": orgResourceViewRule("View projects"),
  "project.create": {
    label: "Create projects",
    scope: { admin: ANY, member: ANY, editor: "only inline from New job, under an existing client" },
    memberFlag: "canCreateJobs",
    editorFlag: "canCreateJobs",
    allow: (ctx, r) => {
      if (isAdmin(ctx)) return true;
      if (!ctx.canCreateJobs) return false;
      if (ctx.role === "photographer") return true;
      return r !== undefined && r.inlineFromJobCreate === true;
    },
  },
  "project.edit": orgResourceEditRule("Edit projects"),
  "project.archive": adminOnly("Archive projects"),
  "project.share_with_client": adminOnly("Share a project with the client"),
  "user.view": {
    label: "View users",
    scope: { admin: "full profile", member: "reduced projection, staff only", editor: "reduced projection, staff only" },
    allow: (ctx, target) => isAdmin(ctx) || target === undefined || target.role !== "client",
  },
  "user.invite": adminOnly("Invite users", "any role (clients: a portal-enabled client)"),
  "user.edit": {
    label: "Edit users",
    scope: { admin: ANY, member: "self", editor: "self", client: "self" },
    allow: (ctx, target) => isAdmin(ctx) || (target !== undefined && target.id === ctx.userId),
  },
  "user.change_email": adminOnly("Change email addresses", "self, or anyone but the primary owner"),
  "user.change_role": {
    label: "Change roles",
    scope: { admin: "photographer ⇄ editor only; never self" },
    allow: (ctx, target) => {
      if (!target) return true;
      if (target.id === ctx.userId) return false;
      const staff = STAFF_ROLES as readonly Role[];
      return staff.includes(target.role) && (target.nextRole === undefined || staff.includes(target.nextRole));
    },
  },
  "user.deactivate": {
    label: "Deactivate users",
    scope: { admin: "anyone but self (keeps one active admin)" },
    allow: (_ctx, target) => target === undefined || target.id !== _ctx.userId,
  },
  "user.reactivate": adminOnly("Reactivate users"),
  "user.set_capacity": adminOnly("Set capacity"),
  "user.set_permissions": {
    label: "Set permission switches",
    scope: { admin: "active team members and editors" },
    allow: (_ctx, target) =>
      target === undefined || (target.isActive && (target.role === "editor" || (target.role === "photographer" && target.isAdmin !== true))),
  },
  "user.set_admin": {
    label: "Make / revoke admin",
    scope: { admin: "active photographers, not self (keeps one active admin)" },
    allow: (ctx, target) => target === undefined || (target.role === "photographer" && target.isActive && target.id !== ctx.userId),
  },
  "user.reset_password": {
    label: "Reset passwords",
    scope: { admin: "staff and client users", member: "self", editor: "self", client: "self" },
    allow: (ctx, target) => isAdmin(ctx) || (target !== undefined && target.id === ctx.userId),
  },
  "user.anonymise": {
    label: "Anonymise deactivated users",
    scope: { admin: "deactivated users" },
    allow: (_ctx, target) => target !== undefined && !target.isActive,
  },
  "org.transfer_primary_owner": {
    label: "Transfer primary ownership",
    scope: { admin: "primary owner only; to another active admin" },
    allow: (ctx, target) =>
      ctx.isPrimaryOwner && (target === undefined || (target.id !== ctx.userId && target.role === "photographer" && target.isAdmin === true && target.isActive)),
  },
  "team.manage": adminOnly("Manage teams"),
  "settings.view": adminOnly("View organisation settings"),
  "settings.manage": adminOnly("Manage organisation settings"),
  "workflow.view": adminOnly("View workflows"),
  "workflow.manage": adminOnly("Manage workflows"),
  "job_type.manage": adminOnly("Manage job types"),
  "automation.manage": adminOnly("Manage automations"),
  "automation.view_runs": adminOnly("View automation runs"),
  "notification.read": selfRule("Read notifications", true),
  "notification.prefs": selfRule("Notification preferences", true),
  "saved_view.manage": selfRule("Manage own saved views", false),
  "saved_view.share": adminOnly("Share saved views", "staff only"),
  "dashboard.customise": selfRule("Customise dashboard", false),
  "search.global": { label: "Global search", scope: STAFF_SCOPE("visible jobs"), allow: () => true },
  "view.business_scope": {
    label: "Switch between My shoots and Whole business",
    scope: { admin: ANY, member: ANY },
    memberFlag: "canViewAllJobs",
    allow: (ctx) => hasBusinessView(ctx),
  },
  "portal.view_job": {
    label: "See shared work in the portal",
    scope: { client: "jobs shared with their client" },
    allow: (ctx, job) => job !== undefined && portalCanViewJob(ctx, job),
  },
  "portal.give_feedback": {
    label: "Leave feedback in the portal",
    scope: { client: "shared jobs, while feedback is on" },
    allow: (ctx, job) => job !== undefined && portalCanGiveFeedback(ctx, job),
  },
  "system.sweep": adminOnly("Run the overdue sweep"),
  "system.integrity": adminOnly("Integrity check / repair"),
} satisfies PolicyTable;

function portalCanGiveFeedback(ctx: AuthContext, job: PortalJobRef): boolean {
  return ctx.clientFeedbackEnabled && job.statusCategory !== "cancelled" && portalCanViewJob(ctx, job);
}

/* ------------------------------------------------------------------ */
/*  Hard rules + entry points                                          */
/* ------------------------------------------------------------------ */

/**
 * Actions the system context (automations, sweep, seed) may perform: the
 * automation action allowlist. `notify` has no Action key — sending a
 * notification is not permission-checked; `job.view` is needed to load jobs.
 */
export const SYSTEM_ACTION_ALLOWLIST: ReadonlySet<Action> = new Set<Action>([
  "job.view",
  "job.assign_editor",
  "job.transition",
  "job.set_priority",
  "note.add",
]);

const SELF_REVIEW: ReadonlySet<Action> = new Set<Action>(SELF_REVIEW_ACTIONS);
const PRIMARY_OWNER_PROTECTED: ReadonlySet<Action> = new Set<Action>(PRIMARY_OWNER_PROTECTED_ACTIONS);

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

function isJobRef(v: unknown): v is JobPermissionRef {
  return isRecord(v) && typeof v.id === "string" && "editorId" in v && "createdByUserId" in v;
}

/**
 * @deprecated roles-v2: use `personaMayEver(personaOf(ctx), action)`. Kept for
 * not-yet-ported pre-checks: true when ANY persona of `role` may ever perform it.
 */
export function roleCanEver(role: Role, action: Action): boolean {
  const personas: readonly Persona[] = role === "photographer" ? ["admin", "member"] : [role];
  return personas.some((p) => personaMayEver(p, action));
}

/** Why `can()` would deny on a hard rule (UI hints); null = decided by the rule. */
export function hardRuleDenial(ctx: AuthContext, action: Action, resource?: unknown): "self_review" | "primary_owner" | null {
  if (SELF_REVIEW.has(action) && isJobRef(resource) && workedOnJob(ctx, resource)) return "self_review";
  if (PRIMARY_OWNER_PROTECTED.has(action) && isRecord(resource) && resource.isPrimaryOwner === true && resource.id !== ctx.userId) {
    return "primary_owner";
  }
  return null;
}

export function can<A extends Action>(ctx: AuthContext, action: A, resource?: ResourceOf<A>): boolean {
  if (!ctx.isActive) return false;
  const orgId = resourceOrganisationId(resource);
  if (orgId !== undefined && orgId !== ctx.organisationId) return false;
  if (ctx.isSystem) return SYSTEM_ACTION_ALLOWLIST.has(action);
  if (ctx.userId === null) return false;
  if (!personaMayEver(personaOf(ctx), action)) return false;
  if (hardRuleDenial(ctx, action, resource) !== null) return false;
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
/*  Job refs from rows                                                 */
/* ------------------------------------------------------------------ */

/** Facts a Job row does not carry (loaded by `loadJobRef` in src/server/auth/job-ref.ts). */
export interface JobRefFacts {
  pastEditorIds?: readonly string[];
  /** Unknown → closed (conservative: never widens the editor draft window). */
  draftClosed?: boolean;
  /** Unknown → false. */
  projectSharedWithClient?: boolean;
}

/**
 * JobPermissionRef from a jobs row. Prefer `loadJobRef()` (one query, every fact);
 * this sync builder treats unknown facts conservatively (draft closed, project not shared).
 */
export function jobRefFromRow(job: Job, facts: JobRefFacts = {}): JobPermissionRef {
  return {
    id: job.id,
    organisationId: job.organisationId,
    photographerId: job.photographerId,
    editorId: job.editorId,
    createdByUserId: job.createdByUserId,
    createdByRole: job.createdByRole,
    statusCategory: job.statusCategory,
    isPaused: job.isPaused,
    ...(facts.pastEditorIds ? { pastEditorIds: facts.pastEditorIds } : {}),
    draftClosed: facts.draftClosed ?? true,
    clientId: job.clientId,
    sharedWithClient: job.sharedWithClient,
    projectSharedWithClient: facts.projectSharedWithClient ?? false,
    cancelledAt: job.cancelledAt,
  };
}

/* ------------------------------------------------------------------ */
/*  SQL twins                                                          */
/* ------------------------------------------------------------------ */

const DENY_ALL: SQL = sql`1 = 0`;

/**
 * Row-level predicate over `jobs` implementing `job.view` (§2.3). Always includes the
 * organisation filter. Clients, inactive actors and user-less non-system contexts → no rows.
 */
export function visibleJobsWhere(ctx: AuthContext): SQL {
  const inOrg = eq(jobs.organisationId, ctx.organisationId);
  if (!ctx.isActive) return and(inOrg, DENY_ALL) as SQL;
  if (isAdmin(ctx)) return inOrg;
  const me = ctx.userId;
  if (me === null || ctx.role === "client") return and(inOrg, DENY_ALL) as SQL;

  if (ctx.role === "photographer") {
    if (ctx.canViewAllJobs) return inOrg;
    return and(inOrg, managedJobsWhere(ctx)) as SQL;
  }
  const scopes: SQL[] = [
    eq(jobs.editorId, me),
    sql`exists (select 1 from ${jobAssignments} where ${jobAssignments.jobId} = ${jobs.id} and ${jobAssignments.userId} = ${me} and ${jobAssignments.role} = 'editor')`,
    eq(jobs.createdByUserId, me),
  ];
  if (ctx.canViewTeamJobs) scopes.push(sql`${jobs.editorId} is not null`);
  return and(inOrg, or(...scopes)) as SQL;
}

/** SQL twin of `managesJob` (photographers only; else no rows). Never a view scope on its own (§8). */
export function managedJobsWhere(ctx: AuthContext): SQL {
  const me = ctx.userId;
  if (ctx.role !== "photographer" || me === null) return DENY_ALL;
  return or(eq(jobs.photographerId, me), and(eq(jobs.createdByUserId, me), eq(jobs.createdByRole, "photographer"))) as SQL;
}

/**
 * Client portal predicate (§7.2): the client's jobs that are shared (job or project),
 * cancelled ones only for PORTAL_CANCELLED_VISIBLE_DAYS. Non-client contexts → no rows.
 * Every portal query starts from this; a job outside it is 404.
 */
export function portalJobsWhere(ctx: AuthContext): SQL {
  const inOrg = eq(jobs.organisationId, ctx.organisationId);
  if (!ctx.isActive || ctx.isSystem || ctx.role !== "client" || ctx.clientId === null || ctx.userId === null) {
    return and(inOrg, DENY_ALL) as SQL;
  }
  return and(
    inOrg,
    eq(jobs.clientId, ctx.clientId),
    or(ne(jobs.statusCategory, "cancelled"), gte(jobs.cancelledAt, portalCancelledCutoff(ctx))),
    or(
      eq(jobs.sharedWithClient, true),
      sql`exists (select 1 from ${projects} where ${projects.id} = ${jobs.projectId} and ${projects.organisationId} = ${jobs.organisationId} and ${projects.sharedWithClient} = true)`,
    ),
  ) as SQL;
}

/** Alias of `portalJobsWhere` (name used in the foundation brief). */
export const clientVisibleJobsWhere = portalJobsWhere;

/* ------------------------------------------------------------------ */
/*  Roles page                                                         */
/* ------------------------------------------------------------------ */

export interface RuleMeta {
  label: string;
  scope: Partial<Record<Persona, string>>;
  memberFlag?: MemberFlag;
  editorFlag?: EditorFlag;
}

/** Label / scope notes / switches of an action's rule (Roles page, tests). */
export function ruleMeta(action: Action): RuleMeta {
  const table: PolicyTable = POLICY;
  const { label, scope, memberFlag, editorFlag } = table[action];
  return { label, scope, ...(memberFlag ? { memberFlag } : {}), ...(editorFlag ? { editorFlag } : {}) };
}

/** One row per action; member/editor cells name the switch they need. */
export function permissionMatrix(): PermissionMatrixRow[] {
  return ACTIONS.map((action) => {
    const rule = ruleMeta(action);
    const cells = {} as PermissionMatrixRow["cells"];
    for (const persona of PERSONAS) {
      const allowed = personaMayEver(persona, action);
      cells[persona] = { allowed, scope: allowed ? (rule.scope[persona] ?? ANY) : "never" };
      if (allowed && persona === "member" && rule.memberFlag) cells[persona].memberFlag = rule.memberFlag;
      if (allowed && persona === "editor" && rule.editorFlag) cells[persona].editorFlag = rule.editorFlag;
    }
    return { action, label: rule.label, cells };
  });
}

/** "needs: Review submissions" helper for the Roles page. */
export function flagLabel(flag: MemberFlag | EditorFlag, persona: "member" | "editor"): string {
  return persona === "member" ? MEMBER_FLAG_META[flag as MemberFlag].label : EDITOR_FLAG_META[flag as EditorFlag].label;
}

export { PERMISSIONS, personaMayEver };
