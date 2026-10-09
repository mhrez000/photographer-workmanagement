/**
 * Shared service plumbing.
 *
 * CONVENTION (every service module follows it):
 *   - mutation signature: `fn(tx: Tx, ctx: AuthContext, input: unknown)`;
 *     body order: permission check → `parseInput(Schema, input)` → writes
 *     (ledger order per guard.ts) → `recordEvent` in the same tx
 *   - route handlers / server actions call `withTx((tx) => fn(tx, ctx, input))`
 *   - read helpers take `DbLike` (Db or Tx)
 *
 * Loaders return the row or throw NotFoundError — for missing ids AND for
 * ids that belong to another organisation (existence never leaks, §3.1).
 */
import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import { getDb, type Db, type DbLike, type Tx } from "@/db/index";
import {
  automations,
  clients,
  jobAssignments,
  jobComments,
  jobLinks,
  jobNotes,
  jobRevisions,
  jobTypes,
  jobs,
  projects,
  savedViews,
  teams,
  users,
  workflowStatuses,
  workflows,
} from "@/db/schema";
import { MANAGEMENT_ROLES } from "@/lib/constants";
import type {
  AuthContext,
  Automation,
  Client,
  Job,
  JobComment,
  JobLink,
  JobNote,
  JobPermissionRef,
  JobRevision,
  JobType,
  Project,
  SavedView,
  StatusRef,
  Team,
  User,
  UserRef,
  Workflow,
  WorkflowStatus,
} from "@/lib/types";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { runPendingAutomations } from "./automationEngine";

export type { Db, DbLike, Tx };

/* ------------------------------------------------------------------ */
/*  Transactions + input parsing                                       */
/* ------------------------------------------------------------------ */

export interface WithTxOptions {
  /** Defaults to `getDb()` (tests pass their own). */
  db?: Db;
  /** SQLite BEGIN mode; IMMEDIATE takes the write lock up front (no upgrade deadlocks). */
  behavior?: "deferred" | "immediate" | "exclusive";
}

/**
 * Runs `fn` in one synchronous better-sqlite3 transaction and returns its
 * result. `fn` must not be async (better-sqlite3 rejects a returned promise);
 * do any async work (bcrypt, fetch) before calling `withTx`.
 */
export function withTx<T>(fn: (tx: Tx) => T, options: WithTxOptions = {}): T {
  const db = options.db ?? getDb();
  return db.transaction(fn, { behavior: options.behavior ?? "immediate" });
}

/**
 * `withTx` + the automation post-commit step (ARCHITECTURE.md §7): runs `fn`
 * in one transaction, then — only after it COMMITTED — executes the
 * organisation's pending automation runs (each in its own transaction).
 * Route handlers / server actions use this for every job mutation so rules
 * fire right away; a failure in the runner never fails the mutation (the
 * runs stay `pending` and the sweep replays them).
 */
export function withTxThenAutomations<T>(ctx: AuthContext, fn: (tx: Tx) => T, options: WithTxOptions = {}): T {
  const result = withTx(fn, options);
  runAutomationsAfterCommit(options.db ?? getDb(), ctx.organisationId);
  return result;
}

/** Post-commit hook for code that manages its own transactions (bulk runner, sweep). Never throws. */
export function runAutomationsAfterCommit(db: Db, organisationId: string): void {
  try {
    runPendingAutomations(db, organisationId);
  } catch (err) {
    console.warn("[automations] post-commit run failed; pending runs will be replayed by the sweep", err instanceof Error ? err.message : err);
  }
}

/** Type helper: the transaction type of a Db (`Tx`). */
export type TxOf<D extends Db> = Parameters<Parameters<D["transaction"]>[0]>[0];

/**
 * `schema.parse(input)` that throws `ValidationError` (400) with
 * `details = { formErrors, fieldErrors }` instead of a ZodError.
 */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fieldErrors: Record<string, string[]> = {};
  const formErrors: string[] = [];
  for (const issue of result.error.issues) {
    const key = issue.path.map(String).join(".");
    if (key) (fieldErrors[key] ??= []).push(issue.message);
    else formErrors.push(issue.message);
  }
  const first = result.error.issues[0];
  const message = first ? (first.path.length ? `${first.path.join(".")}: ${first.message}` : first.message) : "Invalid input";
  throw new ValidationError(message, { formErrors, fieldErrors });
}

/** Optimistic concurrency: throws 409 with the current row when versions differ. */
export function assertVersion<T extends { version: number }>(row: T, expectedVersion: number): void {
  if (row.version !== expectedVersion) {
    throw new ConflictError(undefined, row);
  }
}

/* ------------------------------------------------------------------ */
/*  Loaders (404 for missing or foreign)                               */
/* ------------------------------------------------------------------ */

export function loadJobInOrg(db: DbLike, ctx: AuthContext, jobId: string): Job {
  const row = db.select().from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.organisationId, ctx.organisationId))).get();
  if (!row) throw new NotFoundError("Job");
  return row;
}

/** Ids of every editor who ever held the job (job_assignments history). */
export function loadPastEditorIds(db: DbLike, jobId: string): string[] {
  const rows = db
    .selectDistinct({ userId: jobAssignments.userId })
    .from(jobAssignments)
    .where(and(eq(jobAssignments.jobId, jobId), eq(jobAssignments.role, "editor")))
    .all();
  return rows.map((r) => r.userId);
}

export function jobPermissionRef(job: Job, pastEditorIds?: readonly string[]): JobPermissionRef {
  return {
    id: job.id,
    organisationId: job.organisationId,
    photographerId: job.photographerId,
    editorId: job.editorId,
    createdByUserId: job.createdByUserId,
    statusCategory: job.statusCategory,
    isPaused: job.isPaused,
    ...(pastEditorIds ? { pastEditorIds } : {}),
  };
}

/**
 * The facts permissions.ts needs about a job. `pastEditorIds` is loaded for
 * editors only (the `past` read-only scope).
 */
export function loadJobPermissionRef(db: DbLike, ctx: AuthContext, jobId: string): JobPermissionRef {
  const job = loadJobInOrg(db, ctx, jobId);
  return jobPermissionRef(job, ctx.role === "editor" ? loadPastEditorIds(db, job.id) : undefined);
}

export function loadUserInOrg(db: DbLike, ctx: AuthContext, userId: string): User {
  const row = db.select().from(users).where(and(eq(users.id, userId), eq(users.organisationId, ctx.organisationId))).get();
  if (!row) throw new NotFoundError("User");
  return row;
}

/** Several users at once; throws NotFoundError if any id is missing/foreign. */
export function loadUsersInOrg(db: DbLike, ctx: AuthContext, userIds: readonly string[]): User[] {
  const unique = Array.from(new Set(userIds));
  if (unique.length === 0) return [];
  const rows = db
    .select()
    .from(users)
    .where(and(inArray(users.id, unique), eq(users.organisationId, ctx.organisationId)))
    .all();
  if (rows.length !== unique.length) throw new NotFoundError("User");
  return rows;
}

export function loadClientInOrg(db: DbLike, ctx: AuthContext, clientId: string): Client {
  const row = db.select().from(clients).where(and(eq(clients.id, clientId), eq(clients.organisationId, ctx.organisationId))).get();
  if (!row) throw new NotFoundError("Client");
  return row;
}

export function loadProjectInOrg(db: DbLike, ctx: AuthContext, projectId: string): Project {
  const row = db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.organisationId, ctx.organisationId))).get();
  if (!row) throw new NotFoundError("Project");
  return row;
}

export function loadJobTypeInOrg(db: DbLike, ctx: AuthContext, jobTypeId: string): JobType {
  const row = db.select().from(jobTypes).where(and(eq(jobTypes.id, jobTypeId), eq(jobTypes.organisationId, ctx.organisationId))).get();
  if (!row) throw new NotFoundError("Job type");
  return row;
}

export function loadWorkflowInOrg(db: DbLike, ctx: AuthContext, workflowId: string): Workflow {
  const row = db.select().from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.organisationId, ctx.organisationId))).get();
  if (!row) throw new NotFoundError("Workflow");
  return row;
}

/** A status that belongs to `workflowId` (and to the actor's organisation). */
export function loadStatusInWorkflow(db: DbLike, ctx: AuthContext, workflowId: string, statusId: string): WorkflowStatus {
  const row = db
    .select()
    .from(workflowStatuses)
    .where(
      and(
        eq(workflowStatuses.id, statusId),
        eq(workflowStatuses.workflowId, workflowId),
        eq(workflowStatuses.organisationId, ctx.organisationId),
      ),
    )
    .get();
  if (!row) throw new NotFoundError("Status");
  return row;
}

export function loadRevisionInOrg(db: DbLike, ctx: AuthContext, revisionId: string): JobRevision {
  const row = db
    .select()
    .from(jobRevisions)
    .where(and(eq(jobRevisions.id, revisionId), eq(jobRevisions.organisationId, ctx.organisationId)))
    .get();
  if (!row) throw new NotFoundError("Revision");
  return row;
}

export function loadCommentInOrg(db: DbLike, ctx: AuthContext, commentId: string): JobComment {
  const row = db
    .select()
    .from(jobComments)
    .where(and(eq(jobComments.id, commentId), eq(jobComments.organisationId, ctx.organisationId)))
    .get();
  if (!row) throw new NotFoundError("Comment");
  return row;
}

export function loadNoteInOrg(db: DbLike, ctx: AuthContext, noteId: string): JobNote {
  const row = db.select().from(jobNotes).where(and(eq(jobNotes.id, noteId), eq(jobNotes.organisationId, ctx.organisationId))).get();
  if (!row) throw new NotFoundError("Note");
  return row;
}

export function loadLinkInOrg(db: DbLike, ctx: AuthContext, linkId: string): JobLink {
  const row = db.select().from(jobLinks).where(and(eq(jobLinks.id, linkId), eq(jobLinks.organisationId, ctx.organisationId))).get();
  if (!row) throw new NotFoundError("Link");
  return row;
}

export function loadTeamInOrg(db: DbLike, ctx: AuthContext, teamId: string): Team {
  const row = db.select().from(teams).where(and(eq(teams.id, teamId), eq(teams.organisationId, ctx.organisationId))).get();
  if (!row) throw new NotFoundError("Team");
  return row;
}

export function loadAutomationInOrg(db: DbLike, ctx: AuthContext, automationId: string): Automation {
  const row = db
    .select()
    .from(automations)
    .where(and(eq(automations.id, automationId), eq(automations.organisationId, ctx.organisationId)))
    .get();
  if (!row) throw new NotFoundError("Automation");
  return row;
}

export function loadSavedViewInOrg(db: DbLike, ctx: AuthContext, viewId: string): SavedView {
  const row = db
    .select()
    .from(savedViews)
    .where(and(eq(savedViews.id, viewId), eq(savedViews.organisationId, ctx.organisationId)))
    .get();
  if (!row) throw new NotFoundError("Saved view");
  return row;
}

/* ------------------------------------------------------------------ */
/*  Mappers / projections                                              */
/* ------------------------------------------------------------------ */

export function userRef(row: Pick<User, "id" | "name" | "role" | "avatarColour" | "isActive">): UserRef {
  return { id: row.id, name: row.name, role: row.role, avatarColour: row.avatarColour, isActive: row.isActive };
}

export function statusRef(row: Pick<WorkflowStatus, "id" | "key" | "name" | "category" | "colour" | "sortOrder">): StatusRef {
  return { id: row.id, key: row.key, name: row.name, category: row.category, colour: row.colour, sortOrder: row.sortOrder };
}

/** A user row without secrets (password hash, session version). */
export type SafeUser = Omit<User, "passwordHash" | "sessionVersion">;

export function safeUser(row: User): SafeUser {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { passwordHash, sessionVersion, ...rest } = row;
  return rest;
}

/**
 * Users projection by viewer (§3.2): owners/managers and the user themself
 * get the full safe row; photographers/editors get `UserRef` only
 * (`id, name, role, avatarColour, isActive`).
 */
export function redactUser(row: User, ctx: AuthContext): SafeUser | UserRef {
  if (MANAGEMENT_ROLES.includes(ctx.role) || row.id === ctx.userId) return safeUser(row);
  return userRef(row);
}
