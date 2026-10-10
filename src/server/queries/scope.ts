/**
 * Read-side scoping + the shared JobRow projection (ARCHITECTURE.md §3.1, §10).
 *
 * Every list/read in src/server/queries starts from `visibleJobsWhere(ctx)`
 * (re-exported here). `selectJobs()` is the one joined SELECT that produces
 * `JobRow`s: it always ANDs the visibility predicate (which always carries the
 * organisation filter) with the caller's conditions.
 *
 * Deadline semantics: deadlines are ISO instants at the end of the civil day
 * in the org timezone. Overdue / due-today are compared as instants (same
 * as src/lib/metrics.ts); the civil due day is read 1 ms before the stored
 * instant so both encodings (`next-day 00:00` and `23:59:59.999`) map to the
 * intended day.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { first, type DbLike } from "@/db/index";
import {
  clients,
  jobAssignments,
  jobLinks,
  jobTypes,
  jobs,
  organisationSettings,
  projects,
  users,
  workflowStatuses,
  workflowTransitions,
} from "@/db/schema";
import {
  LINK_KIND_META,
  PRIORITIES,
  STATUS_CATEGORIES,
  STATUS_CATEGORY_META,
  type LinkKind,
  type StatusCategory,
} from "@/lib/constants";
import { addCivilDays, civilDate, civilDiffDays, endOfCivilDayIso, startOfCivilDayIso, todayCivil } from "@/lib/dates";
import { durationSeconds, isDueTodayAt, isPastDue } from "@/lib/metrics";
import type { AuthContext, Job, JobPermissionRef, JobRow, OrganisationSettings, StatusRef, UserRef } from "@/lib/types";
import type { EdgeLike, StatusLike, WorkflowJobLike } from "@/lib/workflow";
import { isDeadlineBound } from "@/lib/workflow";
import {
  can,
  canSeeManagementEvents,
  canViewJob,
  isAdmin,
  isAssignedJob,
  isTeamViewJob,
  jobRefFromRow,
  visibleJobsWhere,
} from "@/server/auth/permissions";
import { loadJobRef } from "@/server/auth/job-ref";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { myShootsWhere, resolveScopeFrom, type ViewScope } from "@/server/view-scope";

export { canSeeManagementEvents, canViewJob, visibleJobsWhere };
export type { ViewScope };

/**
 * Staff-only read gate (`app.access`): client (portal) contexts get 403 on
 * every staff read that is not already gated by a job / org action. The
 * system context passes (it reads for seeds, sweeps and automations).
 */
export function assertStaffRead(ctx: AuthContext): void {
  if (ctx.isSystem) return;
  if (!can(ctx, "app.access")) throw new ForbiddenError("app.access", "This area is for studio staff");
}

/* ------------------------------------------------------------------ */
/*  Personal vs business view (docs/ROLES.md §8)                       */
/* ------------------------------------------------------------------ */

/**
 * The personal/business switch as list queries receive it: `scope` = the
 * request's `?scope=` value, `scopeCookie` = the `pwm_scope` cookie value
 * (routes read the cookie; queries never touch request state). "all" is
 * accepted as an alias of "business".
 */
export interface ViewScopeOptions {
  scope?: string | null;
  scopeCookie?: string | null;
}

function normaliseScope(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return value === "all" ? "business" : value;
}

/**
 * Resolved view scope (`resolveScopeFrom`): null for anyone without
 * `view.business_scope` (any requested value is ignored, never widened);
 * a valid param beats the cookie; default "business".
 */
export function viewScopeFor(ctx: AuthContext, opts: ViewScopeOptions = {}): ViewScope | null {
  return resolveScopeFrom(ctx, normaliseScope(opts.scope), normaliseScope(opts.scopeCookie));
}

/** Extra job predicate for a resolved scope: "mine" = my shoots (`photographer_id = me`); otherwise none. */
export function viewScopeWhere(ctx: AuthContext, scope: ViewScope | null): SQL | undefined {
  return scope === "mine" ? myShootsWhere(ctx) : undefined;
}

/**
 * Jobs only an admin can review (§8 `needsAdminReviewWhere`): no active
 * photographer who manages the job (photographer, or creator as a
 * photographer) can review it — i.e. none of them is an admin or a member
 * with Review submissions. Covers editor-created jobs whose photographer lacks
 * ⚑review and "photographer12-style" juniors.
 */
export function needsAdminReviewWhere(): SQL {
  return sql`not exists (
    select 1 from ${users} rv
     where rv.organisation_id = ${jobs.organisationId}
       and rv.is_active and rv.role = 'photographer'
       and (rv.is_admin or rv.can_review_submissions)
       and (rv.id = ${jobs.photographerId} or (rv.id = ${jobs.createdByUserId} and ${jobs.createdByRole} = 'photographer'))
  )`;
}

/* ------------------------------------------------------------------ */
/*  Editor read cut-off (docs/ROLES.md §2.3)                           */
/* ------------------------------------------------------------------ */

/** The editor-assignment facts the cut-off needs. */
export interface EditorAssignmentFact {
  userId: string;
  assignedAt: string;
  unassignedAt: string | null;
}

/**
 * Cut-off instant for an editor whose only access to `job` is `past` or
 * `created` (not assigned, not teamView): the latest `unassigned_at` of my
 * editor rows (past), else the `assigned_at` of the first editor assignment
 * that is not mine (created, never held). null = no cut-off (full view).
 * Non-editors → null.
 */
export function editorReadCutoff(ctx: AuthContext, job: JobPermissionRef, editorAssignments: readonly EditorAssignmentFact[]): string | null {
  if (ctx.role !== "editor" || ctx.userId === null || ctx.isSystem) return null;
  if (isAssignedJob(ctx, job) || isTeamViewJob(ctx, job)) return null;
  const me = ctx.userId;
  const mine = editorAssignments.filter((a) => a.userId === me);
  if (mine.length > 0) {
    if (mine.some((a) => a.unassignedAt === null)) return null;
    return mine.map((a) => a.unassignedAt as string).sort().at(-1) ?? null;
  }
  const others = editorAssignments.filter((a) => a.userId !== me).map((a) => a.assignedAt).sort();
  return others[0] ?? null;
}

/** True when a row written at `createdAt` by `authorId` passes the cut-off. */
export function passesCutoff(cutoff: string | null, createdAt: string, authorId: string | null | undefined, me: string | null): boolean {
  return cutoff === null || createdAt <= cutoff || (me !== null && authorId === me);
}

/**
 * SQL twin of `editorReadCutoff` correlated on the outer `jobs` row (text
 * instant or NULL). Only meaningful for editors.
 */
export function editorCutoffSql(ctx: AuthContext): SQL {
  const me = ctx.userId ?? "";
  const full = ctx.canViewTeamJobs
    ? sql`(${jobs.editorId} = ${me} or ${jobs.editorId} is not null)`
    : sql`(${jobs.editorId} is not null and ${jobs.editorId} = ${me})`;
  return sql`(case
    when ${full} then null
    when exists (select 1 from ${jobAssignments} ca where ca.job_id = ${jobs.id} and ca.role = 'editor' and ca.user_id = ${me})
      then (select case when bool_or(ca.unassigned_at is null) then null else max(ca.unassigned_at) end
              from ${jobAssignments} ca where ca.job_id = ${jobs.id} and ca.role = 'editor' and ca.user_id = ${me})
    else (select min(ca.assigned_at) from ${jobAssignments} ca where ca.job_id = ${jobs.id} and ca.role = 'editor' and ca.user_id <> ${me})
  end)`;
}

/**
 * Row filter for job-scoped rows (`createdAt`, `authorId` columns of the row)
 * under the editor cut-off, correlated on the outer `jobs` row. Non-editors
 * (and the system context) → undefined (no filter).
 */
export function editorCutoffWhere(ctx: AuthContext, createdAt: SQLWrapper, authorId: SQLWrapper): SQL | undefined {
  if (ctx.role !== "editor" || ctx.isSystem || isAdmin(ctx)) return undefined;
  const cutoff = editorCutoffSql(ctx);
  return or(sql`${cutoff} is null`, sql`${createdAt} <= ${cutoff}`, sql`${authorId} = ${ctx.userId ?? ""}`) as SQL;
}

/** How the current editor of a past/created-only job is shown to another editor (§2.3: no name, no avatar). */
export const ANOTHER_EDITOR: UserRef = { id: "another-editor", name: "Another editor", role: "editor", avatarColour: "#94a3b8", isActive: true };

/**
 * Editors without "See other editors' jobs" only see a job held by someone
 * else through `past` / `created` access: the holder's identity is hidden.
 */
export function redactOtherEditor(ctx: AuthContext, ref: UserRef | null): UserRef | null {
  if (ref === null || ctx.isSystem || ctx.role !== "editor" || ctx.canViewTeamJobs || ref.id === ctx.userId) return ref;
  return ANOTHER_EDITOR;
}

/** Editor assignment facts per job id (for `editorReadCutoff`). */
export async function loadEditorAssignmentFacts(db: DbLike, ctx: AuthContext, jobIds: readonly string[]): Promise<Map<string, EditorAssignmentFact[]>> {
  const out = new Map<string, EditorAssignmentFact[]>();
  const ids = [...new Set(jobIds)];
  if (ids.length === 0) return out;
  const rows = await db
    .select({ jobId: jobAssignments.jobId, userId: jobAssignments.userId, assignedAt: jobAssignments.assignedAt, unassignedAt: jobAssignments.unassignedAt })
    .from(jobAssignments)
    .where(and(eq(jobAssignments.organisationId, ctx.organisationId), inArray(jobAssignments.jobId, ids), eq(jobAssignments.role, "editor")))
    .orderBy(asc(jobAssignments.assignedAt), asc(jobAssignments.rowid));
  for (const r of rows) out.set(r.jobId, [...(out.get(r.jobId) ?? []), { userId: r.userId, assignedAt: r.assignedAt, unassignedAt: r.unassignedAt }]);
  return out;
}

/* ------------------------------------------------------------------ */
/*  Aliases + projection                                               */
/* ------------------------------------------------------------------ */

export const photographerUser = alias(users, "photographer_user");
export const editorUser = alias(users, "editor_user");

/** Columns of the JobRow SELECT (full job row + every joined ref). */
export const JOB_ROW_FIELDS = {
  job: jobs,
  client: { id: clients.id, name: clients.name },
  project: { id: projects.id, name: projects.name, clientId: projects.clientId },
  jobType: { id: jobTypes.id, name: jobTypes.name, colour: jobTypes.colour },
  status: {
    id: workflowStatuses.id,
    key: workflowStatuses.key,
    name: workflowStatuses.name,
    category: workflowStatuses.category,
    colour: workflowStatuses.colour,
    sortOrder: workflowStatuses.sortOrder,
  },
  photographer: {
    id: photographerUser.id,
    name: photographerUser.name,
    role: photographerUser.role,
    avatarColour: photographerUser.avatarColour,
    isActive: photographerUser.isActive,
  },
  editor: {
    id: editorUser.id,
    name: editorUser.name,
    role: editorUser.role,
    avatarColour: editorUser.avatarColour,
    isActive: editorUser.isActive,
  },
};

/** One raw joined row of `JOB_ROW_FIELDS`. */
export interface RawJobRow {
  job: Job;
  client: { id: string; name: string };
  project: { id: string; name: string; clientId: string };
  jobType: { id: string; name: string; colour: string };
  status: StatusRef;
  photographer: UserRef | null;
  editor: UserRef | null;
}

/** Base FROM … JOIN … used by every job list (dynamic so callers can add where/order/limit). */
export function jobRowQuery(db: DbLike) {
  return db
    .select(JOB_ROW_FIELDS)
    .from(jobs)
    .innerJoin(clients, eq(clients.id, jobs.clientId))
    .innerJoin(projects, eq(projects.id, jobs.projectId))
    .innerJoin(jobTypes, eq(jobTypes.id, jobs.jobTypeId))
    .innerJoin(workflowStatuses, eq(workflowStatuses.id, jobs.statusId))
    .leftJoin(photographerUser, eq(photographerUser.id, jobs.photographerId))
    .leftJoin(editorUser, eq(editorUser.id, jobs.editorId))
    .$dynamic();
}

/** COUNT(*) over the same joins (so filters on client/project/user names work). */
export function jobCountQuery(db: DbLike) {
  return db
    .select({ n: sql<number>`count(*)` })
    .from(jobs)
    .innerJoin(clients, eq(clients.id, jobs.clientId))
    .innerJoin(projects, eq(projects.id, jobs.projectId))
    .innerJoin(jobTypes, eq(jobTypes.id, jobs.jobTypeId))
    .innerJoin(workflowStatuses, eq(workflowStatuses.id, jobs.statusId))
    .leftJoin(photographerUser, eq(photographerUser.id, jobs.photographerId))
    .leftJoin(editorUser, eq(editorUser.id, jobs.editorId))
    .$dynamic();
}

export interface SelectJobsOptions {
  where?: SQL | undefined;
  orderBy?: SQL[];
  limit?: number;
  offset?: number;
}

/** Visible jobs (visibility ∧ org ∧ `where`) as raw joined rows. */
export async function selectRawJobs(db: DbLike, ctx: AuthContext, opts: SelectJobsOptions = {}): Promise<RawJobRow[]> {
  let q = jobRowQuery(db).where(and(visibleJobsWhere(ctx), opts.where));
  q = q.orderBy(...(opts.orderBy && opts.orderBy.length > 0 ? opts.orderBy : defaultJobOrder()));
  if (opts.limit !== undefined) q = q.limit(opts.limit);
  if (opts.offset !== undefined && opts.offset > 0) q = q.offset(opts.offset);
  return (await q) as RawJobRow[];
}

/** Visible jobs mapped to `JobRow` (primary links loaded in one extra query). */
export async function selectJobRows(db: DbLike, ctx: AuthContext, opts: SelectJobsOptions = {}): Promise<JobRow[]> {
  return mapJobRows(db, ctx, await selectRawJobs(db, ctx, opts));
}

/** Count of visible jobs matching `where`. */
export async function countJobs(db: DbLike, ctx: AuthContext, where?: SQL): Promise<number> {
  const row = await first(jobCountQuery(db).where(and(visibleJobsWhere(ctx), where)));
  return Number(row?.n ?? 0);
}

export function defaultJobOrder(): SQL[] {
  return [sql`${jobs.dueDate} asc nulls last`, desc(jobs.createdAt), asc(jobs.id)];
}

/* ------------------------------------------------------------------ */
/*  JobRow mapping                                                     */
/* ------------------------------------------------------------------ */

export type PrimaryLink = JobRow["primaryLink"];

/** Current link rank for `JobRow.primaryLink`: finished work > editing workspace > raw files. */
function linkRank(kind: LinkKind): number {
  if (LINK_KIND_META[kind].finishedWork) return 3;
  if (kind === "editing_workspace") return 2;
  if (kind === "raw_files") return 1;
  return 0;
}

/** Most relevant current link per job (finished work, else workspace, else raw files; latest wins). */
export async function loadPrimaryLinks(db: DbLike, ctx: AuthContext, jobIds: readonly string[]): Promise<Map<string, NonNullable<PrimaryLink>>> {
  const out = new Map<string, NonNullable<PrimaryLink> & { rank: number; createdAt: string }>();
  if (jobIds.length === 0) return new Map();
  const rows = await db
    .select({ id: jobLinks.id, jobId: jobLinks.jobId, kind: jobLinks.kind, url: jobLinks.url, label: jobLinks.label, createdAt: jobLinks.createdAt })
    .from(jobLinks)
    .where(
      and(
        eq(jobLinks.organisationId, ctx.organisationId),
        inArray(jobLinks.jobId, [...new Set(jobIds)]),
        isNull(jobLinks.supersededAt),
        isNull(jobLinks.removedAt),
      ),
    )
    .orderBy(asc(jobLinks.createdAt), asc(jobLinks.id));
  for (const r of rows) {
    const rank = linkRank(r.kind);
    if (rank === 0) continue;
    const cur = out.get(r.jobId);
    if (!cur || rank > cur.rank || (rank === cur.rank && r.createdAt > cur.createdAt)) {
      out.set(r.jobId, { id: r.id, kind: r.kind, url: r.url, label: r.label, rank, createdAt: r.createdAt });
    }
  }
  const result = new Map<string, NonNullable<PrimaryLink>>();
  for (const [jobId, v] of out) result.set(jobId, { id: v.id, kind: v.kind, url: v.url, label: v.label });
  return result;
}

/** Civil due day of a stored deadline instant (read 1 ms early; see file header). */
export function dueCivil(due: string | null, timeZone: string): string | null {
  if (!due) return null;
  const t = Date.parse(due);
  if (!Number.isFinite(t)) return null;
  return civilDate(new Date(t - 1), timeZone);
}

/** Days from today (org tz) to the civil due day; negative = overdue; null = no due date. */
export function daysRemainingFor(due: string | null, now: string, timeZone: string): number | null {
  const d = dueCivil(due, timeZone);
  if (!d) return null;
  return civilDiffDays(todayCivil(timeZone, new Date(now)), d);
}

/** Overdue / due-today flags for a job (only DEADLINE_BOUND categories can be either). */
export function deadlineFlags(category: StatusCategory, due: string | null, now: string, timeZone: string): { isOverdue: boolean; isDueToday: boolean } {
  if (!isDeadlineBound(category)) return { isOverdue: false, isDueToday: false };
  return { isOverdue: isPastDue(due, now), isDueToday: isDueTodayAt(due, now, timeZone) };
}

export function toJobRow(raw: RawJobRow, ctx: AuthContext, now: string, primaryLink: PrimaryLink): JobRow {
  const j = raw.job;
  const tz = ctx.settings.timezone;
  const flags = deadlineFlags(j.statusCategory, j.dueDate, now, tz);
  return {
    id: j.id,
    jobNumber: j.jobNumber,
    name: j.name,
    client: { id: raw.client.id, name: raw.client.name },
    project: { id: raw.project.id, name: raw.project.name, clientId: raw.project.clientId },
    jobType: { id: raw.jobType.id, name: raw.jobType.name, colour: raw.jobType.colour },
    photographer: raw.photographer ? { ...raw.photographer } : null,
    editor: redactOtherEditor(ctx, raw.editor ? { ...raw.editor } : null),
    status: { ...raw.status },
    statusCategory: j.statusCategory,
    statusEnteredAt: j.statusEnteredAt,
    priority: j.priority,
    createdAt: j.createdAt,
    shootDate: j.shootDate,
    dueDate: j.dueDate,
    reviewDueDate: j.reviewDueDate,
    deliveryDueDate: j.deliveryDueDate,
    daysRemaining: daysRemainingFor(j.dueDate, now, tz),
    isOverdue: flags.isOverdue,
    isDueToday: flags.isDueToday,
    isPaused: j.isPaused,
    revisionCount: j.revisionCount,
    lastActivityAt: j.lastActivityAt,
    completionPercent: j.completionPercent,
    primaryLink,
    estimatedHours: j.estimatedHours,
    version: j.version,
    timeInStatusSeconds: durationSeconds(j.statusEnteredAt, null, now),
  };
}

/** Maps raw rows to JobRows (one query for all primary links). */
export async function mapJobRows(db: DbLike, ctx: AuthContext, raws: readonly RawJobRow[], now: string = ctx.now()): Promise<JobRow[]> {
  const links = await loadPrimaryLinks(
    db,
    ctx,
    raws.map((r) => r.job.id),
  );
  return raws.map((r) => toJobRow(r, ctx, now, links.get(r.job.id) ?? null));
}

/* ------------------------------------------------------------------ */
/*  Permission / workflow adapters                                     */
/* ------------------------------------------------------------------ */

/** Sync ref from a job row (unknown facts conservative). Prefer `loadVisibleJob` / `loadJobRef`. */
export function permissionRefOf(job: Job, pastEditorIds?: readonly string[]): JobPermissionRef {
  return jobRefFromRow(job, pastEditorIds ? { pastEditorIds } : {});
}

/** The job facts lib/workflow helpers need. */
export function workflowJobOf(job: Job, editorIsActive: boolean | undefined, pastEditorIds?: readonly string[]): WorkflowJobLike {
  return {
    ...permissionRefOf(job, pastEditorIds),
    statusId: job.statusId,
    previousStatusId: job.previousStatusId,
    ...(editorIsActive === undefined ? {} : { editorIsActive }),
  };
}

export interface WorkflowGraph {
  statuses: StatusLike[];
  edges: EdgeLike[];
}

/** Statuses + edges (archived rows included; helpers filter them) per workflow id. */
export async function loadWorkflowGraphs(db: DbLike, ctx: AuthContext, workflowIds: readonly string[]): Promise<Map<string, WorkflowGraph>> {
  const ids = [...new Set(workflowIds)];
  const out = new Map<string, WorkflowGraph>();
  if (ids.length === 0) return out;
  for (const id of ids) out.set(id, { statuses: [], edges: [] });
  const statuses = await db
    .select()
    .from(workflowStatuses)
    .where(and(eq(workflowStatuses.organisationId, ctx.organisationId), inArray(workflowStatuses.workflowId, ids)))
    .orderBy(asc(workflowStatuses.sortOrder), asc(workflowStatuses.createdAt), asc(workflowStatuses.id));
  for (const s of statuses) {
    out.get(s.workflowId)?.statuses.push({
      id: s.id,
      key: s.key,
      name: s.name,
      category: s.category,
      sortOrder: s.sortOrder,
      isInitial: s.isInitial,
      archivedAt: s.archivedAt,
      colour: s.colour,
    });
  }
  const edges = await db
    .select()
    .from(workflowTransitions)
    .where(and(eq(workflowTransitions.organisationId, ctx.organisationId), inArray(workflowTransitions.workflowId, ids)))
    .orderBy(asc(workflowTransitions.createdAt), asc(workflowTransitions.id));
  for (const e of edges) {
    out.get(e.workflowId)?.edges.push({
      id: e.id,
      fromStatusId: e.fromStatusId,
      toStatusId: e.toStatusId,
      allowedRoles: e.allowedRoles,
      requiresAssignedEditor: e.requiresAssignedEditor,
      assigneeOnly: e.assigneeOnly,
      isReopen: e.isReopen,
      archivedAt: e.archivedAt,
      label: e.label,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  SQL helpers                                                        */
/* ------------------------------------------------------------------ */

/** CASE expression ordering a category column by STATUS_CATEGORIES order. */
export function categoryOrderSql(column: SQLWrapper = jobs.statusCategory): SQL {
  const whens = STATUS_CATEGORIES.map((c, i) => sql`when ${c} then ${i}`);
  return sql`(case ${column} ${sql.join(whens, sql` `)} else 99 end)`;
}

/** CASE expression ordering priority low → urgent. */
export function priorityOrderSql(): SQL {
  const whens = PRIORITIES.map((p, i) => sql`when ${p} then ${i}`);
  return sql`(case ${jobs.priority} ${sql.join(whens, sql` `)} else 1 end)`;
}

/** `jobs.status_category IN (…)` (empty list → false). */
export function categoryIn(categories: readonly StatusCategory[]): SQL {
  if (categories.length === 0) return sql`1 = 0`;
  return inArray(jobs.statusCategory, [...categories]);
}

/** Escapes LIKE wildcards; use with `escape '\\'`. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** `column ILIKE %q% ESCAPE '\'` — case-insensitive substring match (Postgres LIKE is case-sensitive). */
export function likeSql(column: SQLWrapper, q: string): SQL {
  return sql`${column} ilike ${likePattern(q)} escape '\\'`;
}

/* ------------------------------------------------------------------ */
/*  Org clock helpers                                                  */
/* ------------------------------------------------------------------ */

export async function loadOrgSettingsRow(db: DbLike, ctx: AuthContext): Promise<OrganisationSettings | undefined> {
  return first(db.select().from(organisationSettings).where(eq(organisationSettings.organisationId, ctx.organisationId)));
}

export interface OrgDayBounds {
  now: string;
  today: string;
  /** Start of today (ISO instant). */
  startOfToday: string;
  /** End of today = the stored deadline instant for "due today". */
  endOfToday: string;
  endOfTomorrow: string;
  /** Week containing today honouring organisation_settings.week_starts_on: [start, end) instants. */
  weekStart: string;
  weekEnd: string;
}

export function orgDayBounds(ctx: AuthContext, now: string, weekStartsOn = 1): OrgDayBounds {
  const tz = ctx.settings.timezone;
  const today = todayCivil(tz, new Date(now));
  const [y, m, d] = today.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const offset = (dow - weekStartsOn + 7) % 7;
  const weekStartCivil = addCivilDays(today, -offset);
  return {
    now,
    today,
    startOfToday: startOfCivilDayIso(today, tz),
    endOfToday: endOfCivilDayIso(today, tz),
    endOfTomorrow: endOfCivilDayIso(addCivilDays(today, 1), tz),
    weekStart: startOfCivilDayIso(weekStartCivil, tz),
    weekEnd: startOfCivilDayIso(addCivilDays(weekStartCivil, 7), tz),
  };
}

/** Category colour fallback for refs built without a status row. */
export function categoryHex(category: StatusCategory): string {
  return STATUS_CATEGORY_META[category].hex;
}

/* ------------------------------------------------------------------ */
/*  Single-job access + user refs                                      */
/* ------------------------------------------------------------------ */

export interface VisibleJob {
  job: Job;
  ref: JobPermissionRef;
}

/**
 * Loads a job in the actor's organisation and checks `action` (job.view by
 * default). Missing, foreign AND not-visible jobs all throw NotFoundError, so
 * existence never leaks. Editors get `pastEditorIds` (the read-only scope).
 */
export async function loadVisibleJob(
  db: DbLike,
  ctx: AuthContext,
  jobId: string,
  action: "job.view" | "job.view_history" = "job.view",
): Promise<VisibleJob> {
  const { job, ref } = await loadJobRef(db, ctx, jobId);
  if (!can(ctx, action, ref)) throw new NotFoundError("Job");
  return { job, ref };
}

/** UserRefs for ids in the actor's organisation (unknown / foreign ids are absent). */
export async function loadUserRefs(db: DbLike, ctx: AuthContext, ids: Iterable<string | null | undefined>): Promise<Map<string, UserRef>> {
  const unique = [...new Set([...ids].filter((x): x is string => typeof x === "string" && x.length > 0))];
  const out = new Map<string, UserRef>();
  if (unique.length === 0) return out;
  const rows = await db
    .select({ id: users.id, name: users.name, role: users.role, avatarColour: users.avatarColour, isActive: users.isActive })
    .from(users)
    .where(and(eq(users.organisationId, ctx.organisationId), inArray(users.id, unique)));
  for (const r of rows) out.set(r.id, { ...r });
  return out;
}

/** StatusRefs by id (org-scoped; archived statuses included so history renders). */
export async function loadStatusRefs(db: DbLike, ctx: AuthContext, ids: Iterable<string | null | undefined>): Promise<Map<string, StatusRef>> {
  const unique = [...new Set([...ids].filter((x): x is string => typeof x === "string" && x.length > 0))];
  const out = new Map<string, StatusRef>();
  if (unique.length === 0) return out;
  const rows = await db
    .select({
      id: workflowStatuses.id,
      key: workflowStatuses.key,
      name: workflowStatuses.name,
      category: workflowStatuses.category,
      colour: workflowStatuses.colour,
      sortOrder: workflowStatuses.sortOrder,
    })
    .from(workflowStatuses)
    .where(and(eq(workflowStatuses.organisationId, ctx.organisationId), inArray(workflowStatuses.id, unique)));

  for (const r of rows) out.set(r.id, { ...r });
  return out;
}
