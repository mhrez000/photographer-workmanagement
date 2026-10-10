/**
 * Activity feeds (ARCHITECTURE.md §5, §10 `/activity`, job Activity tab).
 *
 * Scoping:
 *  - every query is org-filtered;
 *  - `visibility = 'management'` rows only for roles passing
 *    `activity.view_management_events` (owner / manager);
 *  - photographers / editors see job events only for jobs passing
 *    `visibleJobsWhere(ctx)`, plus non-job events they performed themselves.
 *
 * Order = (created_at, rowid): events written in the same millisecond keep
 * their insertion order (ids are random nanoids, so `id` is no tie-breaker;
 * `rowid` is the bigint identity column that replaces SQLite's implicit rowid).
 * Cursor = keyset over (created_at DESC, rowid DESC); the encoded cursor
 * still carries `(createdAt, id)` and the id is resolved to its rowid.
 */
import { and, asc, desc, eq, exists, gte, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "@/db/index";
import { activityEvents, jobs, projects, users } from "@/db/schema";
import { ENTITY_TYPES, EVENT_TYPES, type EventType } from "@/lib/constants";
import { describeEventForFeed } from "@/lib/audit-summaries";
import { endOfCivilDayIso, startOfCivilDayIso } from "@/lib/dates";
import type { ActivityEvent, ActivityFeedItem, AuthContext, JobRef, Paginated, UserRef } from "@/lib/types";
import { assertCan, isManagement } from "@/server/auth/permissions";
import { parseInput } from "@/server/services/_shared";
import { canSeeManagementEvents, visibleJobsWhere } from "./scope";

export const ACTIVITY_MAX_LIMIT = 200;
export const ACTIVITY_DEFAULT_LIMIT = 50;

const listOf = <T extends z.ZodType>(item: T) =>
  z.preprocess((v) => {
    if (v === undefined || v === null || v === "") return undefined;
    const arr = (Array.isArray(v) ? v : [v]).flatMap((x) => (typeof x === "string" ? x.split(",") : [x]));
    const out = arr.map((x) => (typeof x === "string" ? x.trim() : x)).filter((x) => x !== "");
    return out.length ? out : undefined;
  }, z.array(item).optional());
const one = <T extends z.ZodType>(item: T) => z.preprocess((v) => (Array.isArray(v) ? v[0] : v === "" ? undefined : v), item);
const bound = one(z.string().regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, "Expected YYYY-MM-DD or an ISO timestamp").optional());

export const ActivityFiltersSchema = z.object({
  userId: one(z.string().min(1).optional()),
  jobId: one(z.string().min(1).optional()),
  /** Events of the project itself and of every job in it. */
  projectId: one(z.string().min(1).optional()),
  /** Events of the client itself, its projects, and every job of the client. */
  clientId: one(z.string().min(1).optional()),
  eventType: listOf(z.enum(EVENT_TYPES)),
  entityType: listOf(z.enum(ENTITY_TYPES)),
  /** Civil date (org tz, inclusive) or ISO instant (inclusive). */
  from: bound,
  /** Civil date (org tz, inclusive) or ISO instant (exclusive). */
  to: bound,
  cursor: one(z.string().min(1).optional()),
  limit: one(z.coerce.number().int().min(1).max(ACTIVITY_MAX_LIMIT).optional()),
});
export type ActivityFiltersInput = z.input<typeof ActivityFiltersSchema>;

/* ------------------------------------------------------------------ */
/*  Cursor                                                             */
/* ------------------------------------------------------------------ */

export function encodeKeysetCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id]), "utf8").toString("base64url");
}

export function decodeKeysetCursor(cursor: string | undefined | null): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") return { createdAt: parsed[0], id: parsed[1] };
  } catch {
    // invalid cursor → first page
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Scoping                                                            */
/* ------------------------------------------------------------------ */

/** Org + management-visibility + job-visibility predicate over activity_events. */
export function activityScopeWhere(db: DbLike, ctx: AuthContext): SQL {
  const parts: SQL[] = [eq(activityEvents.organisationId, ctx.organisationId)];
  if (!canSeeManagementEvents(ctx)) parts.push(eq(activityEvents.visibility, "all"));
  if (!ctx.isSystem && !isManagement(ctx)) {
    const visibleJob = db
      .select({ one: sql`1` })
      .from(jobs)
      .where(and(eq(jobs.id, activityEvents.jobId), visibleJobsWhere(ctx)));
    const own = ctx.userId ? and(isNull(activityEvents.jobId), eq(activityEvents.actorUserId, ctx.userId)) : sql`1 = 0`;
    parts.push(or(and(isNotNull(activityEvents.jobId), exists(visibleJob)), own) as SQL);
  }
  return and(...parts) as SQL;
}

/* ------------------------------------------------------------------ */
/*  Mapping                                                            */
/* ------------------------------------------------------------------ */

/** `activity_events.rowid` — the insertion order (identity column; qualified because the feed joins users / jobs). */
const EVENT_ROWID = activityEvents.rowid;

const FEED_FIELDS = {
  event: activityEvents,
  actor: { id: users.id, name: users.name, role: users.role, avatarColour: users.avatarColour, isActive: users.isActive },
  job: { id: jobs.id, jobNumber: jobs.jobNumber, name: jobs.name },
};

export interface RawFeedRow {
  event: ActivityEvent;
  actor: UserRef | null;
  job: JobRef | null;
}

export function feedQuery(db: DbLike) {
  return db
    .select(FEED_FIELDS)
    .from(activityEvents)
    .leftJoin(users, eq(users.id, activityEvents.actorUserId))
    .leftJoin(jobs, eq(jobs.id, activityEvents.jobId))
    .$dynamic();
}

export function toFeedItem(row: RawFeedRow): ActivityFeedItem {
  const e = row.event;
  const metadata = e.metadata && typeof e.metadata === "object" && !Array.isArray(e.metadata) ? (e.metadata as Record<string, unknown>) : {};
  const job = row.job ? { id: row.job.id, jobNumber: row.job.jobNumber, name: row.job.name } : null;
  const actor = row.actor ? { ...row.actor } : null;
  return {
    id: e.id,
    eventType: e.eventType as EventType,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    actor,
    isSystem: e.actorUserId === null,
    job,
    summary: e.summary,
    sentence: describeEventForFeed(
      { eventType: e.eventType, summary: e.summary, previousValue: e.previousValue, newValue: e.newValue, metadata, automationRunId: e.automationRunId },
      actor?.name ?? null,
      job ? `${job.jobNumber} ${job.name}` : null,
    ),
    previousValue: e.previousValue,
    newValue: e.newValue,
    metadata,
    visibility: e.visibility,
    createdAt: e.createdAt,
  };
}

function boundSql(value: string, side: "from" | "to", tz: string): SQL {
  const civil = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (side === "from") return gte(activityEvents.createdAt, civil ? startOfCivilDayIso(value, tz) : value);
  return civil ? lte(activityEvents.createdAt, endOfCivilDayIso(value, tz)) : lt(activityEvents.createdAt, value);
}

/* ------------------------------------------------------------------ */
/*  listActivity                                                       */
/* ------------------------------------------------------------------ */

/**
 * Global / filtered feed, newest first. Input = `ActivityFiltersInput` (or
 * raw search params). Events the actor may not see are never returned.
 */
export async function listActivity(db: DbLike, ctx: AuthContext, input: unknown = {}): Promise<Paginated<ActivityFeedItem>> {
  assertCan(ctx, "activity.view_global");
  const f = parseInput(ActivityFiltersSchema, input ?? {});
  const tz = ctx.settings.timezone;
  const limit = f.limit ?? ACTIVITY_DEFAULT_LIMIT;
  const parts: (SQL | undefined)[] = [activityScopeWhere(db, ctx)];
  if (f.userId) parts.push(eq(activityEvents.actorUserId, f.userId));
  if (f.jobId) parts.push(eq(activityEvents.jobId, f.jobId));
  if (f.projectId) {
    const inProject = db.select({ one: sql`1` }).from(jobs).where(and(eq(jobs.id, activityEvents.jobId), eq(jobs.projectId, f.projectId)));
    parts.push(or(and(eq(activityEvents.entityType, "project"), eq(activityEvents.entityId, f.projectId)), exists(inProject)));
  }
  if (f.clientId) {
    const inClient = db.select({ one: sql`1` }).from(jobs).where(and(eq(jobs.id, activityEvents.jobId), eq(jobs.clientId, f.clientId)));
    const clientProject = db
      .select({ one: sql`1` })
      .from(projects)
      .where(and(eq(projects.id, activityEvents.entityId), eq(projects.clientId, f.clientId), eq(projects.organisationId, ctx.organisationId)));
    parts.push(
      or(
        and(eq(activityEvents.entityType, "client"), eq(activityEvents.entityId, f.clientId)),
        and(eq(activityEvents.entityType, "project"), exists(clientProject)),
        exists(inClient),
      ),
    );
  }
  if (f.eventType?.length) parts.push(inArray(activityEvents.eventType, f.eventType));
  if (f.entityType?.length) parts.push(inArray(activityEvents.entityType, f.entityType));
  if (f.from) parts.push(boundSql(f.from, "from", tz));
  if (f.to) parts.push(boundSql(f.to, "to", tz));
  const cursor = decodeKeysetCursor(f.cursor);
  if (cursor) {
    parts.push(
      or(
        lt(activityEvents.createdAt, cursor.createdAt),
        and(
          eq(activityEvents.createdAt, cursor.createdAt),
          sql`${EVENT_ROWID} < (SELECT c.rowid FROM activity_events c WHERE c.id = ${cursor.id} AND c.organisation_id = ${ctx.organisationId})`,
        ),
      ),
    );
  }

  const rows = (await feedQuery(db)
    .where(and(...parts))
    .orderBy(desc(activityEvents.createdAt), desc(EVENT_ROWID))
    .limit(limit + 1)) as RawFeedRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(toFeedItem),
    nextCursor: hasMore && last ? encodeKeysetCursor(last.event.createdAt, last.event.id) : null,
  };
}

/** Events of one job of the given types, oldest first, scoped like the feed (no pagination). */
export async function jobEvents(db: DbLike, ctx: AuthContext, jobId: string, eventTypes?: readonly EventType[]): Promise<ActivityFeedItem[]> {
  const rows = (await feedQuery(db)
    .where(
      and(
        activityScopeWhere(db, ctx),
        eq(activityEvents.jobId, jobId),
        eventTypes && eventTypes.length ? inArray(activityEvents.eventType, [...eventTypes]) : undefined,
      ),
    )
    .orderBy(asc(activityEvents.createdAt), asc(EVENT_ROWID))) as RawFeedRow[];

  return rows.map(toFeedItem);
}
