/**
 * Shared service plumbing.
 *
 * CONVENTION (every service module follows it):
 *   - mutation signature: `async fn(tx: Tx, ctx: AuthContext, input: unknown): Promise<R>`;
 *     body order: permission check → `parseInput(Schema, input)` → writes
 *     (ledger order per drizzle/0001_guards.sql) → `await recordEvent` in the same tx
 *   - route handlers / server actions call `await withTx((tx) => fn(tx, ctx, input))`
 *   - read helpers take `DbLike` (Db or Tx) and return Promises
 *   - `.get()` → `await first(q)`; `.all()` → `await q`; `.run()` → `await q`
 *
 * Loaders return the row or throw NotFoundError — for missing ids AND for
 * ids that belong to another organisation (existence never leaks, §3.1).
 */
import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import type { PgTransactionConfig } from "drizzle-orm/pg-core";
import { first, getDb, one, type Db, type DbLike, type Tx } from "@/db/index";
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
export { first, one };

/* ------------------------------------------------------------------ */
/*  Transactions + input parsing                                       */
/* ------------------------------------------------------------------ */

export interface WithTxOptions {
  /** Defaults to `getDb()` (tests pass their own). */
  db?: Db;
  /** Postgres isolation level (default: the server default, READ COMMITTED). */
  isolationLevel?: PgTransactionConfig["isolationLevel"];
}

type CommitHook = () => void | Promise<void>;
const commitHooks = new WeakMap<object, CommitHook[]>();

function runHooks(hooks: readonly CommitHook[]): void {
  for (const hook of hooks) {
    try {
      const result = hook();
      if (result && typeof result.then === "function") {
        result.then(undefined, (err: unknown) => {
          console.warn("[withTx] after-commit hook failed", err instanceof Error ? err.message : err);
        });
      }
    } catch (err) {
      console.warn("[withTx] after-commit hook failed", err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Runs `fn` in ONE Postgres transaction (`BEGIN … COMMIT`, rolled back when
 * `fn` throws/rejects) and resolves with its result. `fn` receives the `tx`
 * handle: every query inside must use it (never `getDb()` / the root db —
 * on PGlite that throws RootDbInTransactionError). Nested
 * `tx.transaction(async (sp) => …)` is a SAVEPOINT.
 * Hooks registered with `afterCommit(tx, …)` run after COMMIT (never after a rollback).
 */
export async function withTx<T>(fn: (tx: Tx) => Promise<T> | T, options: WithTxOptions = {}): Promise<T> {
  const db = options.db ?? getDb();
  const hooks: CommitHook[] = [];
  const result = await db.transaction(
    async (tx) => {
      commitHooks.set(tx, hooks);
      return fn(tx);
    },
    options.isolationLevel ? { isolationLevel: options.isolationLevel } : undefined,
  );
  runHooks(hooks);
  return result;
}

/**
 * Registers `hook` to run once the transaction `tx` (opened by `withTx`)
 * has COMMITTED; dropped on rollback. For a `tx` not opened by `withTx`
 * (a raw `db.transaction`, or a savepoint handle) the hook is scheduled with
 * `setImmediate` instead — still after the current tick, but without the
 * commit guarantee, so the hook must tolerate rows that were rolled back.
 */
export function afterCommit(tx: Tx, hook: CommitHook): void {
  const hooks = commitHooks.get(tx);
  if (hooks) {
    hooks.push(hook);
    return;
  }
  setImmediate(() => runHooks([hook]));
}

/**
 * Runs `fn` in a SAVEPOINT of `tx` (`tx.transaction(async (sp) => …)`) and
 * keeps `afterCommit` working inside it: hooks registered on `sp` join the
 * outer `withTx` transaction's hooks when the savepoint is released, and are
 * dropped when it rolls back. Rejects (after rolling back to the savepoint)
 * when `fn` throws; the outer transaction stays usable.
 */
export async function withSavepoint<T>(tx: Tx, fn: (sp: Tx) => Promise<T> | T): Promise<T> {
  const parent = commitHooks.get(tx);
  const local: CommitHook[] = [];
  const result = await tx.transaction(async (sp) => {
    if (parent) commitHooks.set(sp, local);
    return fn(sp);
  });
  if (parent) parent.push(...local);
  return result;
}

/**
 * `withTx` + the automation post-commit step (ARCHITECTURE.md §7): runs `fn`
 * in one transaction, then — only after it COMMITTED — executes the
 * organisation's pending automation runs (each in its own transaction).
 * Route handlers / server actions use this for every job mutation so rules
 * fire right away; a failure in the runner never fails the mutation (the
 * runs stay `pending` and the sweep replays them).
 */
export async function withTxThenAutomations<T>(ctx: AuthContext, fn: (tx: Tx) => Promise<T> | T, options: WithTxOptions = {}): Promise<T> {
  const result = await withTx(fn, options);
  await runAutomationsAfterCommit(options.db ?? getDb(), ctx.organisationId);
  return result;
}

/** Post-commit hook for code that manages its own transactions (bulk runner, sweep). Never throws. */
export async function runAutomationsAfterCommit(db: Db, organisationId: string): Promise<void> {
  try {
    await runPendingAutomations(db, organisationId);
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

export async function loadJobInOrg(db: DbLike, ctx: AuthContext, jobId: string): Promise<Job> {
  const row = await first(db.select().from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.organisationId, ctx.organisationId))));
  if (!row) throw new NotFoundError("Job");
  return row;
}

/** Ids of every editor who ever held the job (job_assignments history). */
export async function loadPastEditorIds(db: DbLike, jobId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: jobAssignments.userId })
    .from(jobAssignments)
    .where(and(eq(jobAssignments.jobId, jobId), eq(jobAssignments.role, "editor")));
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
export async function loadJobPermissionRef(db: DbLike, ctx: AuthContext, jobId: string): Promise<JobPermissionRef> {
  const job = await loadJobInOrg(db, ctx, jobId);
  return jobPermissionRef(job, ctx.role === "editor" ? await loadPastEditorIds(db, job.id) : undefined);
}

export async function loadUserInOrg(db: DbLike, ctx: AuthContext, userId: string): Promise<User> {
  const row = await first(db.select().from(users).where(and(eq(users.id, userId), eq(users.organisationId, ctx.organisationId))));
  if (!row) throw new NotFoundError("User");
  return row;
}

/** Several users at once; throws NotFoundError if any id is missing/foreign. */
export async function loadUsersInOrg(db: DbLike, ctx: AuthContext, userIds: readonly string[]): Promise<User[]> {
  const unique = Array.from(new Set(userIds));
  if (unique.length === 0) return [];
  const rows = await db
    .select()
    .from(users)
    .where(and(inArray(users.id, unique), eq(users.organisationId, ctx.organisationId)));
  if (rows.length !== unique.length) throw new NotFoundError("User");
  return rows;
}

export async function loadClientInOrg(db: DbLike, ctx: AuthContext, clientId: string): Promise<Client> {
  const row = await first(db.select().from(clients).where(and(eq(clients.id, clientId), eq(clients.organisationId, ctx.organisationId))));
  if (!row) throw new NotFoundError("Client");
  return row;
}

export async function loadProjectInOrg(db: DbLike, ctx: AuthContext, projectId: string): Promise<Project> {
  const row = await first(db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.organisationId, ctx.organisationId))));
  if (!row) throw new NotFoundError("Project");
  return row;
}

export async function loadJobTypeInOrg(db: DbLike, ctx: AuthContext, jobTypeId: string): Promise<JobType> {
  const row = await first(db.select().from(jobTypes).where(and(eq(jobTypes.id, jobTypeId), eq(jobTypes.organisationId, ctx.organisationId))));
  if (!row) throw new NotFoundError("Job type");
  return row;
}

export async function loadWorkflowInOrg(db: DbLike, ctx: AuthContext, workflowId: string): Promise<Workflow> {
  const row = await first(db.select().from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.organisationId, ctx.organisationId))));
  if (!row) throw new NotFoundError("Workflow");
  return row;
}

/** A status that belongs to `workflowId` (and to the actor's organisation). */
export async function loadStatusInWorkflow(db: DbLike, ctx: AuthContext, workflowId: string, statusId: string): Promise<WorkflowStatus> {
  const row = await first(
    db
      .select()
      .from(workflowStatuses)
      .where(
        and(
          eq(workflowStatuses.id, statusId),
          eq(workflowStatuses.workflowId, workflowId),
          eq(workflowStatuses.organisationId, ctx.organisationId),
        ),
      )
  );
  if (!row) throw new NotFoundError("Status");
  return row;
}

export async function loadRevisionInOrg(db: DbLike, ctx: AuthContext, revisionId: string): Promise<JobRevision> {
  const row = await first(
    db
      .select()
      .from(jobRevisions)
      .where(and(eq(jobRevisions.id, revisionId), eq(jobRevisions.organisationId, ctx.organisationId)))
  );
  if (!row) throw new NotFoundError("Revision");
  return row;
}

export async function loadCommentInOrg(db: DbLike, ctx: AuthContext, commentId: string): Promise<JobComment> {
  const row = await first(
    db
      .select()
      .from(jobComments)
      .where(and(eq(jobComments.id, commentId), eq(jobComments.organisationId, ctx.organisationId)))
  );
  if (!row) throw new NotFoundError("Comment");
  return row;
}

export async function loadNoteInOrg(db: DbLike, ctx: AuthContext, noteId: string): Promise<JobNote> {
  const row = await first(db.select().from(jobNotes).where(and(eq(jobNotes.id, noteId), eq(jobNotes.organisationId, ctx.organisationId))));
  if (!row) throw new NotFoundError("Note");
  return row;
}

export async function loadLinkInOrg(db: DbLike, ctx: AuthContext, linkId: string): Promise<JobLink> {
  const row = await first(db.select().from(jobLinks).where(and(eq(jobLinks.id, linkId), eq(jobLinks.organisationId, ctx.organisationId))));
  if (!row) throw new NotFoundError("Link");
  return row;
}

export async function loadTeamInOrg(db: DbLike, ctx: AuthContext, teamId: string): Promise<Team> {
  const row = await first(db.select().from(teams).where(and(eq(teams.id, teamId), eq(teams.organisationId, ctx.organisationId))));
  if (!row) throw new NotFoundError("Team");
  return row;
}

export async function loadAutomationInOrg(db: DbLike, ctx: AuthContext, automationId: string): Promise<Automation> {
  const row = await first(
    db
      .select()
      .from(automations)
      .where(and(eq(automations.id, automationId), eq(automations.organisationId, ctx.organisationId)))
  );
  if (!row) throw new NotFoundError("Automation");
  return row;
}

export async function loadSavedViewInOrg(db: DbLike, ctx: AuthContext, viewId: string): Promise<SavedView> {
  const row = await first(
    db
      .select()
      .from(savedViews)
      .where(and(eq(savedViews.id, viewId), eq(savedViews.organisationId, ctx.organisationId)))
  );
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
