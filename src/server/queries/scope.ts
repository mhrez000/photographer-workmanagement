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
import { and, asc, desc, eq, inArray, isNull, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbLike } from "@/db/index";
import {
  clients,
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
import { can, canSeeManagementEvents, canViewJob, visibleJobsWhere } from "@/server/auth/permissions";
import { NotFoundError } from "@/server/errors";
import { loadJobInOrg, loadPastEditorIds } from "@/server/services/_shared";

export { canSeeManagementEvents, canViewJob, visibleJobsWhere };

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
export function selectRawJobs(db: DbLike, ctx: AuthContext, opts: SelectJobsOptions = {}): RawJobRow[] {
  let q = jobRowQuery(db).where(and(visibleJobsWhere(ctx), opts.where));
  q = q.orderBy(...(opts.orderBy && opts.orderBy.length > 0 ? opts.orderBy : defaultJobOrder()));
  if (opts.limit !== undefined) q = q.limit(opts.limit);
  if (opts.offset !== undefined && opts.offset > 0) q = q.offset(opts.offset);
  return q.all() as RawJobRow[];
}

/** Visible jobs mapped to `JobRow` (primary links loaded in one extra query). */
export function selectJobRows(db: DbLike, ctx: AuthContext, opts: SelectJobsOptions = {}): JobRow[] {
  return mapJobRows(db, ctx, selectRawJobs(db, ctx, opts));
}

/** Count of visible jobs matching `where`. */
export function countJobs(db: DbLike, ctx: AuthContext, where?: SQL): number {
  const row = jobCountQuery(db).where(and(visibleJobsWhere(ctx), where)).get();
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
export function loadPrimaryLinks(db: DbLike, ctx: AuthContext, jobIds: readonly string[]): Map<string, NonNullable<PrimaryLink>> {
  const out = new Map<string, NonNullable<PrimaryLink> & { rank: number; createdAt: string }>();
  if (jobIds.length === 0) return new Map();
  const rows = db
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
    .all();
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
    editor: raw.editor ? { ...raw.editor } : null,
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
export function mapJobRows(db: DbLike, ctx: AuthContext, raws: readonly RawJobRow[], now: string = ctx.now()): JobRow[] {
  const links = loadPrimaryLinks(
    db,
    ctx,
    raws.map((r) => r.job.id),
  );
  return raws.map((r) => toJobRow(r, ctx, now, links.get(r.job.id) ?? null));
}

/* ------------------------------------------------------------------ */
/*  Permission / workflow adapters                                     */
/* ------------------------------------------------------------------ */

export function permissionRefOf(job: Job, pastEditorIds?: readonly string[]): JobPermissionRef {
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
export function loadWorkflowGraphs(db: DbLike, ctx: AuthContext, workflowIds: readonly string[]): Map<string, WorkflowGraph> {
  const ids = [...new Set(workflowIds)];
  const out = new Map<string, WorkflowGraph>();
  if (ids.length === 0) return out;
  for (const id of ids) out.set(id, { statuses: [], edges: [] });
  const statuses = db
    .select()
    .from(workflowStatuses)
    .where(and(eq(workflowStatuses.organisationId, ctx.organisationId), inArray(workflowStatuses.workflowId, ids)))
    .orderBy(asc(workflowStatuses.sortOrder))
    .all();
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
  const edges = db
    .select()
    .from(workflowTransitions)
    .where(and(eq(workflowTransitions.organisationId, ctx.organisationId), inArray(workflowTransitions.workflowId, ids)))
    .all();
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

/** `column LIKE %q% ESCAPE '\'` (ASCII case-insensitive in SQLite). */
export function likeSql(column: SQLWrapper, q: string): SQL {
  return sql`${column} like ${likePattern(q)} escape '\\'`;
}

/* ------------------------------------------------------------------ */
/*  Org clock helpers                                                  */
/* ------------------------------------------------------------------ */

export function loadOrgSettingsRow(db: DbLike, ctx: AuthContext): OrganisationSettings | undefined {
  return db.select().from(organisationSettings).where(eq(organisationSettings.organisationId, ctx.organisationId)).get();
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
export function loadVisibleJob(db: DbLike, ctx: AuthContext, jobId: string, action: "job.view" | "job.view_history" = "job.view"): VisibleJob {
  const job = loadJobInOrg(db, ctx, jobId);
  const ref = permissionRefOf(job, ctx.role === "editor" ? loadPastEditorIds(db, job.id) : undefined);
  if (!can(ctx, action, ref)) throw new NotFoundError("Job");
  return { job, ref };
}

/** UserRefs for ids in the actor's organisation (unknown / foreign ids are absent). */
export function loadUserRefs(db: DbLike, ctx: AuthContext, ids: Iterable<string | null | undefined>): Map<string, UserRef> {
  const unique = [...new Set([...ids].filter((x): x is string => typeof x === "string" && x.length > 0))];
  const out = new Map<string, UserRef>();
  if (unique.length === 0) return out;
  const rows = db
    .select({ id: users.id, name: users.name, role: users.role, avatarColour: users.avatarColour, isActive: users.isActive })
    .from(users)
    .where(and(eq(users.organisationId, ctx.organisationId), inArray(users.id, unique)))
    .all();
  for (const r of rows) out.set(r.id, { ...r });
  return out;
}

/** StatusRefs by id (org-scoped; archived statuses included so history renders). */
export function loadStatusRefs(db: DbLike, ctx: AuthContext, ids: Iterable<string | null | undefined>): Map<string, StatusRef> {
  const unique = [...new Set([...ids].filter((x): x is string => typeof x === "string" && x.length > 0))];
  const out = new Map<string, StatusRef>();
  if (unique.length === 0) return out;
  const rows = db
    .select({
      id: workflowStatuses.id,
      key: workflowStatuses.key,
      name: workflowStatuses.name,
      category: workflowStatuses.category,
      colour: workflowStatuses.colour,
      sortOrder: workflowStatuses.sortOrder,
    })
    .from(workflowStatuses)
    .where(and(eq(workflowStatuses.organisationId, ctx.organisationId), inArray(workflowStatuses.id, unique)))
    .all();
  for (const r of rows) out.set(r.id, { ...r });
  return out;
}
