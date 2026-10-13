/**
 * The simplified Jobs page (docs/SIMPLIFICATION-PLAN.md §3, §4): ONE list of
 * visible jobs cut by the five stages, plus the shared `SimpleJobRow`
 * projection every simplified screen (Home, My jobs, Editors, job page) uses.
 *
 * - Who you are decides which jobs you see (`visibleJobsWhere`), never which
 *   page you open: owners everything, extra photographers their shoots,
 *   editors the jobs given to them. Clients never reach these reads (403).
 * - Stages are a DISPLAY layer (`src/lib/stages.ts`): filters translate a
 *   stage to its status categories (`categoriesForStage`); no row is rewritten.
 * - "Late" is a chip and a filter, not a stage: active stage ∧ due day before
 *   today in the organisation timezone. Done / Cancelled are never late.
 * - Cancelled is not a tab: `showCancelled` adds cancelled jobs to "All active";
 *   `stage: "cancelled"` lists only them.
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { first, type DbLike } from "@/db/index";
import { clients, jobLinks, jobTypes, jobs, projects, workflowStatuses } from "@/db/schema";
import { LINK_KIND_META, type StatusCategory } from "@/lib/constants";
import { addCivilDays, civilDate, endOfCivilDayIso, startOfCivilDayIso } from "@/lib/dates";
import { daysFromToday, isLateCivil } from "@/lib/editorMetrics";
import { ACTIVE_STAGE_CATEGORIES, categoriesForStage, describeStage, STAGES, waitingOnLabel, type Stage } from "@/lib/stages";
import type { AuthContext, SimpleCalendarEvent, SimpleDue, SimpleJobListResult, SimpleJobRow, SimpleLink, StageCounts, StageFilter } from "@/lib/types";
import { parseInput } from "@/server/services/_shared";
import { decodeOffsetCursor, encodeOffsetCursor } from "./jobs";
import {
  assertStaffRead,
  categoryIn,
  editorUser,
  likeSql,
  loadOrgSettingsRow,
  orgDayBounds,
  photographerUser,
  redactOtherEditor,
  visibleJobsWhere,
  type OrgDayBounds,
  type RawJobRow,
} from "./scope";

export const SIMPLE_LIST_DEFAULT_LIMIT = 50;
export const SIMPLE_LIST_MAX_LIMIT = 200;
export const CALENDAR_MAX_JOBS = 2000;

/* ------------------------------------------------------------------ */
/*  Input                                                              */
/* ------------------------------------------------------------------ */

const one = <T extends z.ZodType>(item: T) => z.preprocess((v) => (Array.isArray(v) ? v[0] : v === "" ? undefined : v), item);
const boolish = z.preprocess((v) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "boolean") return v;
  const s = String(Array.isArray(v) ? v[0] : v).toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}, z.boolean().optional());

export const STAGE_FILTERS = ["all_active", ...STAGES] as const satisfies readonly StageFilter[];

export const SimpleJobFiltersSchema = z.object({
  stage: one(z.enum(STAGE_FILTERS).optional()),
  late: boolish,
  showCancelled: boolish,
  q: one(z.string().trim().max(200).optional()),
  /** "none" = jobs without an editor. */
  editorId: one(z.string().min(1).optional()),
  clientId: one(z.string().min(1).optional()),
  cursor: one(z.string().min(1).optional()),
  limit: one(z.coerce.number().int().min(1).max(SIMPLE_LIST_MAX_LIMIT).optional()),
});
export type SimpleJobFiltersInput = z.input<typeof SimpleJobFiltersSchema>;
export type SimpleJobFilters = z.output<typeof SimpleJobFiltersSchema>;

/* ------------------------------------------------------------------ */
/*  Stage / late predicates (SQL)                                      */
/* ------------------------------------------------------------------ */

/** Categories displayed by a stage filter. */
export function categoriesFor(stage: StageFilter, showCancelled = false): StatusCategory[] {
  if (stage === "all_active") return [...ACTIVE_STAGE_CATEGORIES, ...(showCancelled ? categoriesForStage("cancelled") : [])];
  return categoriesForStage(stage);
}

/** `jobs.status_category` in the stage's categories. */
export function stageWhere(stage: StageFilter, showCancelled = false): SQL {
  return categoryIn(categoriesFor(stage, showCancelled));
}

/**
 * SQL twin of `isLateCivil` ∧ active stage: the stored deadline instant is on
 * or before the start of today (both deadline encodings — `23:59:59.999` and
 * `next day 00:00` — then land on a civil day before today).
 */
export function lateWhere(bounds: OrgDayBounds): SQL {
  return and(categoryIn(ACTIVE_STAGE_CATEGORIES), isNotNull(jobs.dueDate), lte(jobs.dueDate, bounds.startOfToday)) as SQL;
}

/** Visible active-stage jobs. */
export function activeStageWhere(): SQL {
  return categoryIn(ACTIVE_STAGE_CATEGORIES);
}

/* ------------------------------------------------------------------ */
/*  Row projection                                                     */
/* ------------------------------------------------------------------ */

/** The JobRow SELECT plus the project address (the Jobs list shows the address). */
export function simpleRowQuery(db: DbLike) {
  return db
    .select({
      job: jobs,
      client: { id: clients.id, name: clients.name },
      project: { id: projects.id, name: projects.name, clientId: projects.clientId },
      projectAddress: projects.address,
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
      editor: { id: editorUser.id, name: editorUser.name, role: editorUser.role, avatarColour: editorUser.avatarColour, isActive: editorUser.isActive },
    })
    .from(jobs)
    .innerJoin(clients, eq(clients.id, jobs.clientId))
    .innerJoin(projects, eq(projects.id, jobs.projectId))
    .innerJoin(jobTypes, eq(jobTypes.id, jobs.jobTypeId))
    .innerJoin(workflowStatuses, eq(workflowStatuses.id, jobs.statusId))
    .leftJoin(photographerUser, eq(photographerUser.id, jobs.photographerId))
    .leftJoin(editorUser, eq(editorUser.id, jobs.editorId))
    .$dynamic();
}

export type RawSimpleRow = RawJobRow & { projectAddress: string | null };

function simpleCountQuery(db: DbLike) {
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

export interface SelectSimpleOptions {
  where?: SQL | undefined;
  orderBy?: SQL[];
  limit?: number;
  offset?: number;
}

/** Visible jobs (visibility ∧ org ∧ `where`) as raw joined rows. */
export async function selectRawSimpleRows(db: DbLike, ctx: AuthContext, opts: SelectSimpleOptions = {}): Promise<RawSimpleRow[]> {
  let q = simpleRowQuery(db).where(and(visibleJobsWhere(ctx), opts.where));
  q = q.orderBy(...(opts.orderBy && opts.orderBy.length > 0 ? opts.orderBy : defaultSimpleOrder()));
  if (opts.limit !== undefined) q = q.limit(opts.limit);
  if (opts.offset !== undefined && opts.offset > 0) q = q.offset(opts.offset);
  return (await q) as RawSimpleRow[];
}

/** Count of visible jobs matching `where`. */
export async function countSimpleRows(db: DbLike, ctx: AuthContext, where?: SQL): Promise<number> {
  const row = await first(simpleCountQuery(db).where(and(visibleJobsWhere(ctx), where)));
  return Number(row?.n ?? 0);
}

/** Due date soonest first (no due date last), then oldest in stage. */
export function defaultSimpleOrder(): SQL[] {
  return [sql`${jobs.dueDate} asc nulls last`, asc(jobs.statusEnteredAt), asc(jobs.id)];
}

/** Done jobs: most recently finished first. */
export function doneOrder(): SQL[] {
  return [sql`coalesce(${jobs.completedAt}, ${jobs.deliveredAt}, ${jobs.approvedAt}, ${jobs.statusEnteredAt}) desc nulls last`, desc(jobs.id)];
}

export interface SimpleLinks {
  finished: SimpleLink | null;
  raw: SimpleLink | null;
}

/**
 * Current finished-work link (latest wins) and current raw-files link per job.
 * "Any link counts as the finished link, including a shared-drive folder":
 * every `finishedWork` kind (finished_files, gallery, client_delivery) qualifies.
 */
export async function loadSimpleLinks(db: DbLike, ctx: AuthContext, jobIds: readonly string[]): Promise<Map<string, SimpleLinks>> {
  const out = new Map<string, SimpleLinks>();
  const ids = [...new Set(jobIds)];
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: jobLinks.id, jobId: jobLinks.jobId, kind: jobLinks.kind, url: jobLinks.url, label: jobLinks.label, createdAt: jobLinks.createdAt })
    .from(jobLinks)
    .where(and(eq(jobLinks.organisationId, ctx.organisationId), inArray(jobLinks.jobId, ids), isNull(jobLinks.supersededAt), isNull(jobLinks.removedAt)))
    .orderBy(asc(jobLinks.createdAt), asc(jobLinks.id));
  for (const r of rows) {
    const cur = out.get(r.jobId) ?? { finished: null, raw: null };
    const link: SimpleLink = { id: r.id, kind: r.kind, url: r.url, label: r.label, addedAt: r.createdAt };
    if (LINK_KIND_META[r.kind].finishedWork) cur.finished = link; // ordered oldest → newest: the latest wins
    else if (r.kind === "raw_files") cur.raw = link;
    out.set(r.jobId, cur);
  }
  return out;
}

/** The due chip for a stored deadline. */
export function simpleDue(dueDate: string | null, category: StatusCategory, bounds: OrgDayBounds, timeZone: string): SimpleDue {
  const active = (ACTIVE_STAGE_CATEGORIES as readonly StatusCategory[]).includes(category);
  const t = dueDate ? Date.parse(dueDate) : Number.NaN;
  return {
    dueDate,
    civilDate: Number.isFinite(t) ? civilDate(new Date(t - 1), timeZone) : null,
    daysFromToday: daysFromToday(dueDate, bounds.today, timeZone),
    late: active && isLateCivil(dueDate, bounds.today, timeZone),
  };
}

/** Maps one raw row (+ its links) to the shared projection. */
export function toSimpleJobRow(raw: RawSimpleRow, ctx: AuthContext, bounds: OrgDayBounds, links: SimpleLinks | undefined): SimpleJobRow {
  const j = raw.job;
  const tz = ctx.settings.timezone;
  const stage = describeStage({ category: j.statusCategory, revisionCount: j.revisionCount, startedAt: j.startedAt, statusEnteredAt: j.statusEnteredAt });
  const photographer = raw.photographer ? { ...raw.photographer } : null;
  const editor = redactOtherEditor(ctx, raw.editor ? { ...raw.editor } : null);
  return {
    id: j.id,
    jobNumber: j.jobNumber,
    name: j.name,
    client: { id: raw.client.id, name: raw.client.name },
    project: { id: raw.project.id, name: raw.project.name, address: raw.projectAddress },
    jobTypeName: raw.jobType.name,
    jobTypeColour: raw.jobType.colour,
    stage,
    waitingOn: waitingOnLabel({ category: j.statusCategory, photographer, editor }, ctx.userId),
    due: simpleDue(j.dueDate, j.statusCategory, bounds, tz),
    rush: j.priority === "urgent",
    photographer,
    editor,
    round: stage.round,
    finishedLink: links?.finished ?? null,
    rawLink: links?.raw ?? null,
    shootDate: j.shootDate,
    statusCategory: j.statusCategory,
    statusEnteredAt: j.statusEnteredAt,
    startedAt: j.startedAt,
    sentAt: j.lastSubmittedAt,
    updatedAt: j.updatedAt,
    version: j.version,
  };
}

/** Raw rows → SimpleJobRows (one extra query for every job's links). */
export async function mapSimpleRows(db: DbLike, ctx: AuthContext, raws: readonly RawSimpleRow[], bounds: OrgDayBounds): Promise<SimpleJobRow[]> {
  const links = await loadSimpleLinks(
    db,
    ctx,
    raws.map((r) => r.job.id),
  );
  return raws.map((r) => toSimpleJobRow(r, ctx, bounds, links.get(r.job.id)));
}

/** Visible jobs matching `where` as SimpleJobRows. */
export async function selectSimpleRows(db: DbLike, ctx: AuthContext, bounds: OrgDayBounds, opts: SelectSimpleOptions = {}): Promise<SimpleJobRow[]> {
  return mapSimpleRows(db, ctx, await selectRawSimpleRows(db, ctx, opts), bounds);
}

/** Day bounds for the organisation clock (loads week_starts_on). */
export async function simpleBounds(db: DbLike, ctx: AuthContext, now: string = ctx.now()): Promise<OrgDayBounds> {
  return orgDayBounds(ctx, now, (await loadOrgSettingsRow(db, ctx))?.weekStartsOn ?? 1);
}

/* ------------------------------------------------------------------ */
/*  Filters → SQL                                                      */
/* ------------------------------------------------------------------ */

/** Editors without "See other editors' jobs" may only filter on themselves / "none" (no name oracle, docs/ROLES.md §2.3). */
function editorFilter(ctx: AuthContext, editorId: string): SQL {
  if (editorId === "none") return isNull(jobs.editorId);
  if (!ctx.isSystem && ctx.role === "editor" && !ctx.canViewTeamJobs && editorId !== ctx.userId) return sql`1 = 0`;
  return eq(jobs.editorId, editorId);
}

/** Search / editor / client predicates (shared by the list and the tab counts). */
export function simpleFiltersWhere(ctx: AuthContext, f: Pick<SimpleJobFilters, "q" | "editorId" | "clientId">): SQL | undefined {
  const parts: SQL[] = [];
  const q = f.q?.trim();
  if (q) {
    parts.push(
      or(likeSql(jobs.name, q), likeSql(jobs.jobNumber, q), likeSql(sql`${clients.name}`, q), likeSql(sql`${projects.name}`, q), likeSql(sql`coalesce(${projects.address}, '')`, q)) as SQL,
    );
  }
  if (f.editorId) parts.push(editorFilter(ctx, f.editorId));
  if (f.clientId) parts.push(eq(jobs.clientId, f.clientId));
  return parts.length ? (and(...parts) as SQL) : undefined;
}

/* ------------------------------------------------------------------ */
/*  listJobsByStage                                                    */
/* ------------------------------------------------------------------ */

/**
 * One page of the Jobs list. `stage` defaults to "all_active"; `late` keeps
 * only late jobs; `showCancelled` adds cancelled jobs to "all_active".
 * Clients → 403. Cursors are opaque offsets (stable for fixed filters).
 */
export async function listJobsByStage(db: DbLike, ctx: AuthContext, input: unknown = {}): Promise<SimpleJobListResult> {
  assertStaffRead(ctx);
  const f = parseInput(SimpleJobFiltersSchema, input ?? {});
  const bounds = await simpleBounds(db, ctx);
  const stage: StageFilter = f.stage ?? "all_active";
  const where = and(stageWhere(stage, f.showCancelled === true), f.late ? lateWhere(bounds) : undefined, simpleFiltersWhere(ctx, f)) as SQL;
  const limit = f.limit ?? SIMPLE_LIST_DEFAULT_LIMIT;
  const offset = decodeOffsetCursor(f.cursor);
  const orderBy = stage === "done" || stage === "cancelled" ? doneOrder() : defaultSimpleOrder();
  const raws = await selectRawSimpleRows(db, ctx, { where, orderBy, limit: limit + 1, offset });
  const hasMore = raws.length > limit;
  const page = hasMore ? raws.slice(0, limit) : raws;
  return {
    rows: await mapSimpleRows(db, ctx, page, bounds),
    nextCursor: hasMore ? encodeOffsetCursor(offset + limit) : null,
    total: await countSimpleRows(db, ctx, where),
  };
}

/* ------------------------------------------------------------------ */
/*  stageCounts                                                        */
/* ------------------------------------------------------------------ */

/** Counts per stage tab + Late + Cancelled under the same search / editor / client filters (one GROUP BY). */
export async function stageCounts(db: DbLike, ctx: AuthContext, input: unknown = {}): Promise<StageCounts> {
  assertStaffRead(ctx);
  const f = parseInput(SimpleJobFiltersSchema, input ?? {});
  const bounds = await simpleBounds(db, ctx);
  const rows = await db
    .select({
      category: jobs.statusCategory,
      n: sql<number>`count(*)`.mapWith(Number),
      late: sql<number>`sum(case when ${lateWhere(bounds)} then 1 else 0 end)`.mapWith(Number),
    })
    .from(jobs)
    .innerJoin(clients, eq(clients.id, jobs.clientId))
    .innerJoin(projects, eq(projects.id, jobs.projectId))
    .where(and(visibleJobsWhere(ctx), simpleFiltersWhere(ctx, f)))
    .groupBy(jobs.statusCategory);
  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  let late = 0;
  for (const r of rows) {
    const stage = STAGES.find((s) => categoriesForStage(s).includes(r.category));
    if (!stage) continue;
    byStage[stage] += r.n || 0;
    late += r.late || 0;
  }
  const allActive = STAGES.filter((s) => (ACTIVE_STAGE_CATEGORIES as readonly StatusCategory[]).some((c) => categoriesForStage(s).includes(c))).reduce(
    (sum, s) => sum + byStage[s],
    0,
  );
  return { allActive, byStage, late, cancelled: byStage.cancelled };
}

/* ------------------------------------------------------------------ */
/*  calendarJobs                                                       */
/* ------------------------------------------------------------------ */

const CIVIL_RE = /^\d{4}-\d{2}-\d{2}$/;

export const CalendarRangeSchema = z.object({
  /** Civil date (inclusive, org tz). */
  from: one(z.string().regex(CIVIL_RE, "Use YYYY-MM-DD")),
  /** Civil date (inclusive, org tz). At most 92 days after `from`. */
  to: one(z.string().regex(CIVIL_RE, "Use YYYY-MM-DD")),
});

/**
 * Shoot dates and due dates (active stages only for due) of visible,
 * non-cancelled jobs between two civil days, for the List / Calendar switch.
 * Dates are end-of-day instants, so civil day d lives in (start(d), end(d)].
 */
export async function calendarJobs(db: DbLike, ctx: AuthContext, input: unknown): Promise<SimpleCalendarEvent[]> {
  assertStaffRead(ctx);
  const q = parseInput(CalendarRangeSchema, input ?? {});
  const tz = ctx.settings.timezone;
  const toCivil = q.to < q.from ? q.from : q.to;
  const capped = addCivilDays(q.from, 92) < toCivil ? addCivilDays(q.from, 92) : toCivil;
  const from = startOfCivilDayIso(q.from, tz);
  const to = endOfCivilDayIso(capped, tz);
  const bounds = await simpleBounds(db, ctx);
  const within = (col: typeof jobs.shootDate | typeof jobs.dueDate) => and(gt(col, from), lte(col, to)) as SQL;
  const rows = await selectSimpleRows(db, ctx, bounds, {
    where: and(ne(jobs.statusCategory, "cancelled"), or(within(jobs.shootDate), and(activeStageWhere(), within(jobs.dueDate)))) as SQL,
    orderBy: [sql`least(${jobs.shootDate}, ${jobs.dueDate}) asc nulls last`, asc(jobs.jobNumber)],
    limit: CALENDAR_MAX_JOBS,
  });
  const inWindow = (at: string | null): at is string => at !== null && at > from && at <= to;
  const events: SimpleCalendarEvent[] = [];
  for (const job of rows) {
    if (inWindow(job.shootDate)) events.push({ id: `${job.id}:shoot`, kind: "shoot", at: job.shootDate, civilDate: civilDate(new Date(Date.parse(job.shootDate) - 1), tz) ?? q.from, job });
    if (job.stage.active && inWindow(job.due.dueDate)) {
      events.push({ id: `${job.id}:due`, kind: "due", at: job.due.dueDate, civilDate: job.due.civilDate ?? q.from, job });
    }
  }
  events.sort((a, b) => a.at.localeCompare(b.at) || (a.kind === b.kind ? 0 : a.kind === "shoot" ? -1 : 1) || a.job.jobNumber.localeCompare(b.job.jobNumber));
  return events;
}
