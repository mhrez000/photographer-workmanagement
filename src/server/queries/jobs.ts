/**
 * All Work / Jobs list (ARCHITECTURE.md §9 `GET /api/jobs`, §10 `/workspace/all`, `/jobs`).
 *
 * `listJobs(db, ctx, input)` parses `input` with `JobListFiltersSchema`
 * (accepts URLSearchParams-style strings / comma lists / arrays), merges a
 * saved view (`viewId`) underneath explicit filters, and returns one page of
 * `JobRow`s scoped by `visibleJobsWhere(ctx)`.
 *
 * Cancelled jobs are hidden unless asked for (`includeCancelled`, a
 * `statusCategory` filter containing "cancelled", or `quick=cancelled`).
 * Cursors are opaque offsets (stable for a fixed filter + sort).
 *
 * Drill-down params (so a KPI / bottleneck count reproduces as a list):
 *   - `completedFrom` / `completedTo` — §8 completedInRange: open stage is
 *     `completed` and `completed_at ∈ [from, to)` (civil `to` = inclusive day)
 *   - `revisedFrom` / `revisedTo`     — a revision was REQUESTED in [from, to)
 *   - `statusEnteredBefore`           — `status_entered_at < value`
 * Aliases: `filter=mine` ≡ `quick=my_jobs`.
 *
 * Page-level parsing (`listJobs`) strips unknown keys so a hand-edited link
 * still renders; the REST endpoint (`listJobsApi`) is strict: an unknown
 * query key is a 400.
 */
import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "@/db/index";
import { clients, jobLinks, jobTypes, jobs, projects, savedViews, workflowStatuses } from "@/db/schema";
import {
  CATEGORY_GROUPS,
  JOB_TABLE_COLUMNS,
  PRIORITIES,
  PRIORITY_META,
  QUICK_FILTERS,
  STATUS_CATEGORIES,
  type JobTableColumn,
  type QuickFilter,
} from "@/lib/constants";
import { addCivilDays, endOfCivilDayIso, startOfCivilDayIso } from "@/lib/dates";
import type { AuthContext, JobRow, SavedViewConfig } from "@/lib/types";
import { NotFoundError } from "@/server/errors";
import { parseInput } from "@/server/services/_shared";
import {
  categoryIn,
  categoryOrderSql,
  editorUser,
  jobCountQuery,
  likeSql,
  loadOrgSettingsRow,
  mapJobRows,
  orgDayBounds,
  photographerUser,
  priorityOrderSql,
  selectRawJobs,
  visibleJobsWhere,
  type OrgDayBounds,
} from "./scope";

/* ------------------------------------------------------------------ */
/*  Input schema                                                       */
/* ------------------------------------------------------------------ */

export const JOB_LIST_MAX_LIMIT = 200;
export const JOB_LIST_DEFAULT_LIMIT = 50;

export const JOB_GROUP_BY = ["status", "editor", "photographer", "client", "priority", "dueDate", "jobType"] as const;
export type JobGroupBy = (typeof JOB_GROUP_BY)[number];

/** string | string[] | "a,b" → string[] (empty → undefined). */
function list<T extends z.ZodType>(item: T) {
  return z.preprocess((v) => {
    if (v === undefined || v === null || v === "") return undefined;
    const arr = Array.isArray(v) ? v : [v];
    const flat = arr.flatMap((x) => (typeof x === "string" ? x.split(",") : [x])).map((x) => (typeof x === "string" ? x.trim() : x));
    const out = flat.filter((x) => x !== "" && x !== undefined && x !== null);
    return out.length === 0 ? undefined : out;
  }, z.array(item).optional());
}

const boolish = z.preprocess((v) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "boolean") return v;
  const s = String(Array.isArray(v) ? v[0] : v).toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}, z.boolean().optional());

const single = <T extends z.ZodType>(item: T) => z.preprocess((v) => (Array.isArray(v) ? v[0] : v === "" ? undefined : v), item);

/** Civil date (YYYY-MM-DD, org tz) or full ISO instant. */
const dateBound = single(z.string().regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, "Expected YYYY-MM-DD or an ISO timestamp").optional());

/** Strict variant for the drill-down bounds: a real civil date or a real ISO instant (with offset). */
const instantBound = single(z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional());

export interface SortSpec {
  column: JobTableColumn;
  dir: "asc" | "desc";
}

const sortItem = z.union([
  z.object({ column: z.enum(JOB_TABLE_COLUMNS), dir: z.enum(["asc", "desc"]).default("asc") }),
  z.string().transform((s, ctx): SortSpec => {
    const raw = s.trim();
    const desc = raw.startsWith("-");
    const [col, dir] = (desc ? raw.slice(1) : raw).split(":");
    if (!(JOB_TABLE_COLUMNS as readonly string[]).includes(col)) {
      ctx.addIssue({ code: "custom", message: `Unknown sort column "${col}"` });
      return z.NEVER;
    }
    const d = desc ? "desc" : dir === "desc" ? "desc" : "asc";
    return { column: col as JobTableColumn, dir: d };
  }),
]);

export const JobListFiltersSchema = z.object({
  q: single(z.string().trim().max(200).optional()),
  quick: list(z.enum(QUICK_FILTERS)),
  statusCategory: list(z.enum(STATUS_CATEGORIES)),
  statusId: list(z.string().min(1)),
  /** "none" matches jobs without an editor. */
  editorId: list(z.string().min(1)),
  /** "none" matches jobs without a photographer. */
  photographerId: list(z.string().min(1)),
  clientId: list(z.string().min(1)),
  projectId: list(z.string().min(1)),
  jobTypeId: list(z.string().min(1)),
  priority: list(z.enum(PRIORITIES)),
  dueFrom: dateBound,
  dueTo: dateBound,
  /** completedInRange (§8): open stage completed and completed_at ≥ completedFrom … */
  completedFrom: instantBound,
  /** … and completed_at < completedTo (a civil date includes that whole day). */
  completedTo: instantBound,
  /** A revision was requested on/after this instant (civil date = start of that day). */
  revisedFrom: instantBound,
  /** … and before this instant (civil date includes that whole day). */
  revisedTo: instantBound,
  /** Current status entered strictly before this instant (review bottleneck drill-down). */
  statusEnteredBefore: instantBound,
  isPaused: boolish,
  includeCancelled: boolish,
  sort: list(sortItem),
  groupBy: single(z.enum(JOB_GROUP_BY).nullable().optional()),
  viewId: single(z.string().min(1).optional()),
  cursor: single(z.string().min(1).optional()),
  limit: single(z.coerce.number().int().min(1).max(JOB_LIST_MAX_LIMIT).optional()),
});

export type JobListFiltersInput = z.input<typeof JobListFiltersSchema>;
export type JobListFilters = z.output<typeof JobListFiltersSchema>;

export interface JobGroup {
  key: string;
  label: string;
  count: number;
}

export interface JobListResult {
  rows: JobRow[];
  nextCursor: string | null;
  /** Total matching rows (all pages). */
  total: number;
  /** Group key per row (parallel to `rows`) when `groupBy` is set. */
  rowGroupKeys: string[] | null;
  /** Every group over the full result (not just this page), in display order. */
  groups: JobGroup[] | null;
  /** The effective filters after merging the saved view. */
  applied: JobListFilters;
}

/* ------------------------------------------------------------------ */
/*  Cursor                                                             */
/* ------------------------------------------------------------------ */

export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
}

export function decodeOffsetCursor(cursor: string | undefined | null): number {
  if (!cursor) return 0;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed && typeof parsed === "object" && "o" in parsed) {
      const o = Number((parsed as { o: unknown }).o);
      if (Number.isInteger(o) && o >= 0) return o;
    }
  } catch {
    // fall through
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/*  Saved view merge                                                   */
/* ------------------------------------------------------------------ */

function loadViewConfig(db: DbLike, ctx: AuthContext, viewId: string): SavedViewConfig {
  const view = db
    .select()
    .from(savedViews)
    .where(and(eq(savedViews.id, viewId), eq(savedViews.organisationId, ctx.organisationId), isNull(savedViews.archivedAt)))
    .get();
  if (!view || (view.ownerUserId !== ctx.userId && !view.isShared)) throw new NotFoundError("Saved view");
  return view.config;
}

function mergeView(db: DbLike, ctx: AuthContext, raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const explicit = raw as Record<string, unknown>;
  const viewId = Array.isArray(explicit.viewId) ? explicit.viewId[0] : explicit.viewId;
  if (typeof viewId !== "string" || viewId === "") return raw;
  const config = loadViewConfig(db, ctx, viewId);
  const base: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config.filters ?? {})) if (v !== null && v !== undefined) base[k] = v;
  if (config.sort?.length) base.sort = config.sort;
  if (config.groupBy) base.groupBy = config.groupBy;
  const merged: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(explicit)) if (v !== undefined && v !== "") merged[k] = v;
  return merged;
}

/* ------------------------------------------------------------------ */
/*  Filter → SQL                                                       */
/* ------------------------------------------------------------------ */

function idList(values: readonly string[], column: typeof jobs.editorId | typeof jobs.photographerId): SQL | undefined {
  const ids = values.filter((v) => v !== "none");
  const parts: SQL[] = [];
  if (ids.length) parts.push(inArray(column, ids));
  if (values.includes("none")) parts.push(isNull(column));
  return parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : or(...parts);
}

function quickFilterSql(ctx: AuthContext, quick: QuickFilter, b: OrgDayBounds): SQL {
  const deadlineBound = categoryIn(CATEGORY_GROUPS.DEADLINE_BOUND);
  const me = ctx.userId ?? "";
  switch (quick) {
    case "my_jobs":
      if (ctx.role === "editor") return eq(jobs.editorId, me);
      if (ctx.role === "photographer") return or(eq(jobs.photographerId, me), eq(jobs.createdByUserId, me)) as SQL;
      return or(eq(jobs.photographerId, me), eq(jobs.editorId, me), eq(jobs.createdByUserId, me)) as SQL;
    case "unassigned":
      return categoryIn(CATEGORY_GROUPS.UNASSIGNED);
    case "overdue":
      return and(deadlineBound, isNotNull(jobs.dueDate), lt(jobs.dueDate, b.now)) as SQL;
    case "due_today":
      return and(deadlineBound, gte(jobs.dueDate, b.now), lte(jobs.dueDate, b.endOfToday)) as SQL;
    case "due_this_week":
      return and(deadlineBound, gt(jobs.dueDate, b.weekStart), lte(jobs.dueDate, b.weekEnd)) as SQL;
    case "awaiting_review":
      return categoryIn(CATEGORY_GROUPS.REVIEWER_HOLDS);
    case "revision_required":
      return categoryIn(["revision"]);
    case "completed":
      return categoryIn(["completed"]);
    case "cancelled":
      return categoryIn(["cancelled"]);
    case "paused":
      return and(eq(jobs.isPaused, true), categoryIn(CATEGORY_GROUPS.ACTIVE)) as SQL;
  }
}

const CIVIL_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Instant bound for the drill-down params. `from`: civil date → start of that
 * day; `to` (exclusive): civil date → start of the NEXT day (the day is
 * included). ISO instants are normalised to the stored `…Z` form so string
 * comparison in SQLite is chronological.
 */
function instantOf(value: string, side: "from" | "to", tz: string): string {
  if (CIVIL_RE.test(value)) return startOfCivilDayIso(side === "from" ? value : addCivilDays(value, 1), tz);
  return new Date(value).toISOString();
}

/** EXISTS a revision requested in [from, to) on the outer job (alias-safe: works with or without joins). */
function revisedInSql(from: string | null, to: string | null): SQL {
  const parts: SQL[] = [sql`r.job_id = "jobs"."id"`];
  if (from !== null) parts.push(sql`r.requested_at >= ${from}`);
  if (to !== null) parts.push(sql`r.requested_at < ${to}`);
  return sql`exists (select 1 from job_revisions r where ${sql.join(parts, sql` and `)})`;
}

function dueBound(value: string, side: "from" | "to", tz: string): SQL {
  const civil = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (side === "from") {
    // A deadline for civil day d is stored in (start(d), end(d)].
    return civil ? gt(jobs.dueDate, startOfCivilDayIso(value, tz)) : gte(jobs.dueDate, value);
  }
  return lte(jobs.dueDate, civil ? endOfCivilDayIso(value, tz) : value);
}

/**
 * The WHERE for a filter set (visibility is added by the select helpers).
 * Exported for kanban / team work, which share the filter vocabulary.
 */
export function jobFiltersWhere(ctx: AuthContext, f: JobListFilters, bounds: OrgDayBounds, opts: { defaultHideCancelled?: boolean } = {}): SQL | undefined {
  const tz = ctx.settings.timezone;
  const parts: (SQL | undefined)[] = [];
  const q = f.q?.trim();
  if (q) {
    parts.push(
      or(
        likeSql(jobs.name, q),
        likeSql(jobs.jobNumber, q),
        likeSql(sql`${clients.name}`, q),
        likeSql(sql`${projects.name}`, q),
        likeSql(sql`coalesce(${projects.address}, '')`, q),
      ),
    );
  }
  for (const quick of f.quick ?? []) parts.push(quickFilterSql(ctx, quick, bounds));
  if (f.statusCategory?.length) parts.push(inArray(jobs.statusCategory, f.statusCategory));
  if (f.statusId?.length) parts.push(inArray(jobs.statusId, f.statusId));
  if (f.editorId?.length) parts.push(idList(f.editorId, jobs.editorId));
  if (f.photographerId?.length) parts.push(idList(f.photographerId, jobs.photographerId));
  if (f.clientId?.length) parts.push(inArray(jobs.clientId, f.clientId));
  if (f.projectId?.length) parts.push(inArray(jobs.projectId, f.projectId));
  if (f.jobTypeId?.length) parts.push(inArray(jobs.jobTypeId, f.jobTypeId));
  if (f.priority?.length) parts.push(inArray(jobs.priority, f.priority));
  if (f.dueFrom) parts.push(dueBound(f.dueFrom, "from", tz));
  if (f.dueTo) parts.push(dueBound(f.dueTo, "to", tz));
  if (f.completedFrom || f.completedTo) {
    parts.push(eq(jobs.statusCategory, "completed"));
    if (f.completedFrom) parts.push(gte(jobs.completedAt, instantOf(f.completedFrom, "from", tz)));
    if (f.completedTo) parts.push(lt(jobs.completedAt, instantOf(f.completedTo, "to", tz)));
  }
  if (f.revisedFrom || f.revisedTo) {
    parts.push(revisedInSql(f.revisedFrom ? instantOf(f.revisedFrom, "from", tz) : null, f.revisedTo ? instantOf(f.revisedTo, "to", tz) : null));
  }
  if (f.statusEnteredBefore) parts.push(lt(jobs.statusEnteredAt, instantOf(f.statusEnteredBefore, "from", tz)));
  if (f.isPaused !== undefined) parts.push(eq(jobs.isPaused, f.isPaused));

  const wantsCancelled =
    f.includeCancelled === true || (f.statusCategory ?? []).includes("cancelled") || (f.quick ?? []).includes("cancelled") || (f.statusId?.length ?? 0) > 0;
  if ((opts.defaultHideCancelled ?? true) && !wantsCancelled) parts.push(ne(jobs.statusCategory, "cancelled"));

  const present = parts.filter((p): p is SQL => p !== undefined);
  return present.length ? and(...present) : undefined;
}

/* ------------------------------------------------------------------ */
/*  Sorting + grouping                                                 */
/* ------------------------------------------------------------------ */

const hasCurrentLinkSql = sql`(exists (select 1 from ${jobLinks} where ${jobLinks.jobId} = ${jobs.id} and ${jobLinks.supersededAt} is null and ${jobLinks.removedAt} is null))`;

/** Sort expressions per table column (each sorted in the requested direction, nulls last). */
function sortExpressions(column: JobTableColumn): SQL[] {
  switch (column) {
    case "job":
      return [sql`length(${jobs.jobNumber})`, sql`${jobs.jobNumber}`];
    case "client":
      return [sql`${clients.name} collate nocase`];
    case "project":
      return [sql`${projects.name} collate nocase`];
    case "photographer":
      return [sql`${photographerUser.name} collate nocase`];
    case "editor":
      return [sql`${editorUser.name} collate nocase`];
    case "status":
      return [categoryOrderSql(), sql`${workflowStatuses.sortOrder}`];
    case "priority":
      return [priorityOrderSql()];
    case "created":
      return [sql`${jobs.createdAt}`];
    case "shootDate":
      return [sql`${jobs.shootDate}`];
    case "dueDate":
    case "daysRemaining":
      return [sql`${jobs.dueDate}`];
    case "revisionCount":
      return [sql`${jobs.revisionCount}`];
    case "lastActivity":
      return [sql`${jobs.lastActivityAt}`];
    case "completionPercent":
      return [sql`${jobs.completionPercent}`];
    case "link":
      return [hasCurrentLinkSql];
    case "jobType":
      return [sql`${jobTypes.name} collate nocase`];
    case "reviewDueDate":
      return [sql`${jobs.reviewDueDate}`];
    case "deliveryDueDate":
      return [sql`${jobs.deliveryDueDate}`];
  }
}

function orderTerm(expr: SQL, dir: "asc" | "desc"): SQL {
  return sql`${expr} ${sql.raw(dir)} nulls last`;
}

interface GroupSql {
  key: SQL;
  label: SQL;
  order: SQL[];
}

function dueBucketSql(b: OrgDayBounds): SQL {
  const deadlineBound = categoryIn(CATEGORY_GROUPS.DEADLINE_BOUND);
  return sql`(case
    when ${jobs.dueDate} is null then 'none'
    when ${jobs.dueDate} < ${b.now} and ${deadlineBound} then 'overdue'
    when ${jobs.dueDate} < ${b.now} then 'past'
    when ${jobs.dueDate} <= ${b.endOfToday} then 'today'
    when ${jobs.dueDate} <= ${b.endOfTomorrow} then 'tomorrow'
    when ${jobs.dueDate} <= ${b.weekEnd} then 'this_week'
    else 'later' end)`;
}

const DUE_BUCKETS: readonly { key: string; label: string }[] = [
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Due today" },
  { key: "tomorrow", label: "Due tomorrow" },
  { key: "this_week", label: "Later this week" },
  { key: "later", label: "Later" },
  { key: "past", label: "Past due date (done)" },
  { key: "none", label: "No due date" },
];

function groupSql(groupBy: JobGroupBy, b: OrgDayBounds): GroupSql {
  switch (groupBy) {
    case "status":
      return { key: sql`${jobs.statusId}`, label: sql`${workflowStatuses.name}`, order: [categoryOrderSql(), sql`${workflowStatuses.sortOrder}`, sql`${jobs.statusId}`] };
    case "editor":
      return {
        key: sql`coalesce(${jobs.editorId}, 'none')`,
        label: sql`coalesce(${editorUser.name}, 'Unassigned')`,
        order: [sql`(${jobs.editorId} is null)`, sql`${editorUser.name} collate nocase`, sql`${jobs.editorId}`],
      };
    case "photographer":
      return {
        key: sql`coalesce(${jobs.photographerId}, 'none')`,
        label: sql`coalesce(${photographerUser.name}, 'No photographer')`,
        order: [sql`(${jobs.photographerId} is null)`, sql`${photographerUser.name} collate nocase`, sql`${jobs.photographerId}`],
      };
    case "client":
      return { key: sql`${jobs.clientId}`, label: sql`${clients.name}`, order: [sql`${clients.name} collate nocase`, sql`${jobs.clientId}`] };
    case "priority":
      // Urgent first.
      return { key: sql`${jobs.priority}`, label: sql`${jobs.priority}`, order: [sql`(${PRIORITIES.length - 1} - ${priorityOrderSql()})`] };
    case "jobType":
      return { key: sql`${jobs.jobTypeId}`, label: sql`${jobTypes.name}`, order: [sql`${jobTypes.name} collate nocase`, sql`${jobs.jobTypeId}`] };
    case "dueDate": {
      const bucket = dueBucketSql(b);
      const whens = DUE_BUCKETS.map((d, i) => sql`when ${d.key} then ${i}`);
      return { key: bucket, label: bucket, order: [sql`(case ${bucket} ${sql.join(whens, sql` `)} else 99 end)`] };
    }
  }
}

function groupLabel(groupBy: JobGroupBy, key: string, rawLabel: string): string {
  if (groupBy === "priority") return PRIORITY_META[key as keyof typeof PRIORITY_META]?.label ?? key;
  if (groupBy === "dueDate") return DUE_BUCKETS.find((d) => d.key === key)?.label ?? key;
  return rawLabel;
}

/* ------------------------------------------------------------------ */
/*  listJobs                                                           */
/* ------------------------------------------------------------------ */

/** Accepted spellings of `filter=` and the quick filter each one means. */
export const JOB_LIST_FILTER_ALIASES = { mine: "my_jobs" } as const satisfies Record<string, QuickFilter>;
type FilterAlias = keyof typeof JOB_LIST_FILTER_ALIASES;
const isAlias = (v: string): v is FilterAlias => Object.prototype.hasOwnProperty.call(JOB_LIST_FILTER_ALIASES, v);

/**
 * Folds alias keys into the canonical vocabulary: `filter=mine` → `quick`
 * gains `my_jobs`. Unknown `filter` values are left in place (the strict API
 * schema rejects them; page parsing drops them).
 */
function applyAliases(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const input = raw as Record<string, unknown>;
  if (input.filter === undefined) return raw;
  const values = (Array.isArray(input.filter) ? input.filter : [input.filter])
    .flatMap((v) => (typeof v === "string" ? v.split(",") : []))
    .map((v) => v.trim())
    .filter((v) => v !== "");
  const known = values.filter(isAlias);
  const unknown = values.filter((v) => !isAlias(v));
  const out: Record<string, unknown> = { ...input };
  if (unknown.length) out.filter = unknown.join(",");
  else delete out.filter;
  if (known.length) {
    const quick = input.quick === undefined || input.quick === "" ? [] : Array.isArray(input.quick) ? input.quick : [input.quick];
    out.quick = [...quick, ...known.map((k) => JOB_LIST_FILTER_ALIASES[k])];
  }
  return out;
}

export function parseJobListFilters(db: DbLike, ctx: AuthContext, input: unknown): JobListFilters {
  return parseInput(JobListFiltersSchema, mergeView(db, ctx, applyAliases(input ?? {})));
}

/** UI-only keys the work table may forward to GET /api/jobs (accepted and ignored). */
const API_IGNORED_KEYS = ["tab", "columns", "dir"] as const;

/**
 * `GET /api/jobs` query: the filter vocabulary + `filter` (alias) + the
 * ignored UI keys, STRICT — a misspelt or unsupported key is a 400 instead
 * of silently returning every job.
 */
export const JobListApiQuerySchema = JobListFiltersSchema.extend({
  filter: list(z.enum(Object.keys(JOB_LIST_FILTER_ALIASES) as [FilterAlias, ...FilterAlias[]])),
  tab: z.unknown().optional(),
  columns: z.unknown().optional(),
  dir: z.unknown().optional(),
}).strict();

/** Every query key GET /api/jobs accepts (pages forward only these to "Load more"). */
export const JOB_LIST_API_KEYS: readonly string[] = Object.keys(JobListApiQuerySchema.shape);

/** Strict check of the REST query (unknown key / alias value → ValidationError); returns the input minus the ignored UI keys. */
function checkApiQuery(input: unknown): Record<string, unknown> {
  parseInput(JobListApiQuerySchema, input ?? {});
  const rest: Record<string, unknown> = { ...((input ?? {}) as Record<string, unknown>) };
  for (const k of API_IGNORED_KEYS) delete rest[k];
  return rest;
}

/** The filters GET /api/jobs applies for `input` (strict; aliases folded; saved view merged). */
export function parseJobListApiQuery(db: DbLike, ctx: AuthContext, input: unknown): JobListFilters {
  return parseJobListFilters(db, ctx, checkApiQuery(input));
}

/** `GET /api/jobs` — `listJobs` behind the strict query schema. */
export function listJobsApi(db: DbLike, ctx: AuthContext, input: unknown = {}): JobListResult {
  return listJobs(db, ctx, checkApiQuery(input));
}

/**
 * One page of visible jobs. `input` = `JobListFiltersInput` (or raw search
 * params). Throws ValidationError for bad input, NotFoundError for a
 * foreign / private saved view.
 */
export function listJobs(db: DbLike, ctx: AuthContext, input: unknown = {}): JobListResult {
  const f = parseJobListFilters(db, ctx, input);
  const now = ctx.now();
  const bounds = orgDayBounds(ctx, now, loadOrgSettingsRow(db, ctx)?.weekStartsOn ?? 1);
  const where = jobFiltersWhere(ctx, f, bounds);
  const limit = f.limit ?? JOB_LIST_DEFAULT_LIMIT;
  const offset = decodeOffsetCursor(f.cursor);

  const group = f.groupBy ? groupSql(f.groupBy, bounds) : null;
  const sorts: SortSpec[] = f.sort?.length ? f.sort : [{ column: "dueDate", dir: "asc" }];
  const orderBy: SQL[] = [
    ...(group ? group.order : []),
    ...sorts.flatMap((s) => sortExpressions(s.column).map((e) => orderTerm(e, s.dir))),
    sql`${jobs.createdAt} desc`,
    sql`${jobs.id} asc`,
  ];

  const raws = selectRawJobs(db, ctx, { where, orderBy, limit: limit + 1, offset });
  const hasMore = raws.length > limit;
  const page = hasMore ? raws.slice(0, limit) : raws;
  const rows = mapJobRows(db, ctx, page, now);

  const totalRow = jobCountQuery(db).where(and(visibleJobsWhere(ctx), where)).get();
  const total = Number(totalRow?.n ?? 0);

  let groups: JobGroup[] | null = null;
  let rowGroupKeys: string[] | null = null;
  if (group && f.groupBy) {
    const groupBy = f.groupBy;
    const counted = db
      .select({ key: sql<string>`${group.key}`, label: sql<string>`${group.label}`, n: sql<number>`count(*)` })
      .from(jobs)
      .innerJoin(clients, eq(clients.id, jobs.clientId))
      .innerJoin(projects, eq(projects.id, jobs.projectId))
      .innerJoin(jobTypes, eq(jobTypes.id, jobs.jobTypeId))
      .innerJoin(workflowStatuses, eq(workflowStatuses.id, jobs.statusId))
      .leftJoin(photographerUser, eq(photographerUser.id, jobs.photographerId))
      .leftJoin(editorUser, eq(editorUser.id, jobs.editorId))
      .where(and(visibleJobsWhere(ctx), where))
      .groupBy(group.key)
      .orderBy(...group.order.map((o) => sql`min(${o})`))
      .all();
    groups = counted.map((g) => ({ key: String(g.key), label: groupLabel(groupBy, String(g.key), String(g.label)), count: Number(g.n) }));
    rowGroupKeys = page.map((r) => rowGroupKey(groupBy, r.job, bounds));
  }

  return {
    rows,
    nextCursor: hasMore ? encodeOffsetCursor(offset + limit) : null,
    total,
    rowGroupKeys,
    groups,
    applied: f,
  };
}

/** JS twin of the group key SQL (for the rows of the current page). */
function rowGroupKey(groupBy: JobGroupBy, job: { statusId: string; editorId: string | null; photographerId: string | null; clientId: string; priority: string; jobTypeId: string; dueDate: string | null; statusCategory: string }, b: OrgDayBounds): string {
  switch (groupBy) {
    case "status":
      return job.statusId;
    case "editor":
      return job.editorId ?? "none";
    case "photographer":
      return job.photographerId ?? "none";
    case "client":
      return job.clientId;
    case "priority":
      return job.priority;
    case "jobType":
      return job.jobTypeId;
    case "dueDate": {
      const due = job.dueDate;
      if (due === null) return "none";
      if (due < b.now) return (CATEGORY_GROUPS.DEADLINE_BOUND as readonly string[]).includes(job.statusCategory) ? "overdue" : "past";
      if (due <= b.endOfToday) return "today";
      if (due <= b.endOfTomorrow) return "tomorrow";
      if (due <= b.weekEnd) return "this_week";
      return "later";
    }
  }
}

/** Visible job by its human number (`/api/jobs/by-number/:n`); 404 when missing or not visible. */
export function getJobRowByNumber(db: DbLike, ctx: AuthContext, jobNumber: string): JobRow {
  const raws = selectRawJobs(db, ctx, { where: sql`upper(${jobs.jobNumber}) = upper(${jobNumber.trim()})`, limit: 1 });
  if (raws.length === 0) throw new NotFoundError("Job");
  return mapJobRows(db, ctx, raws)[0];
}

/** Visible jobs by id (any order), mapped to JobRow; ids not visible are silently skipped. */
export function getJobRowsByIds(db: DbLike, ctx: AuthContext, ids: readonly string[]): JobRow[] {
  if (ids.length === 0) return [];
  return mapJobRows(db, ctx, selectRawJobs(db, ctx, { where: inArray(jobs.id, [...new Set(ids)]) }));
}
