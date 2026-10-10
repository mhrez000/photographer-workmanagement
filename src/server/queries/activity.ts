/**
 * Activity feeds (ARCHITECTURE.md §5, §10 `/activity`, job Activity tab).
 *
 * Scoping:
 *  - every query is org-filtered;
 *  - `visibility = 'management'` rows only for actors passing
 *    `activity.view_management_events` (admins);
 *  - team members / editors see job events only for jobs passing
 *    `visibleJobsWhere(ctx)`, plus non-job events they performed themselves;
 *  - editors with past / created-only access see a job's events up to their
 *    read cut-off (docs/ROLES.md §2.3) plus their own;
 *  - clients never read the staff feed (`activity.view_global` → 403);
 *  - the personal / business view (§8): "mine" keeps events of My shoots
 *    plus the actor's own non-job events.
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
import { ENTITY_TYPES, EVENT_TYPES, NOTE_KIND_META, NOTE_KINDS, type EventType, type NoteKind } from "@/lib/constants";
import { describeEventForFeed } from "@/lib/audit-summaries";
import { endOfCivilDayIso, startOfCivilDayIso } from "@/lib/dates";
import type { ActivityEvent, ActivityFeedItem, AuthContext, JobRef, Paginated, UserRef } from "@/lib/types";
import { assertCan, isAdmin, managedJobsWhere } from "@/server/auth/permissions";
import { parseInput } from "@/server/services/_shared";
import { canSeeManagementEvents, editorCutoffWhere, viewScopeFor, viewScopeWhere, visibleJobsWhere, type ViewScope } from "./scope";

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
  /** Personal / business view (§8); ignored without the scope switch. */
  scope: one(z.enum(["mine", "business", "all"]).optional()),
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

/** Note kinds an editor never reads (`NOTE_KIND_META[kind].editorReadable === false`, docs/ROLES.md §2.4). */
export const EDITOR_HIDDEN_NOTE_KINDS: readonly NoteKind[] = NOTE_KINDS.filter((k) => !NOTE_KIND_META[k].editorReadable);

/**
 * `note.read` on the feed: a note event carries the note's kind (and body) in
 * its snapshots, so editors must not receive events of kinds they cannot read
 * through the notes API (`internal` is already `management` visibility;
 * `client` notes keep `all`). Covers note.added / edited / archived /
 * restored. Non-editors → undefined (members: `client` notes on visible jobs,
 * `internal` stays behind the management tier).
 */
function notePrivacyWhere(ctx: AuthContext): SQL | undefined {
  if (ctx.isSystem || isAdmin(ctx) || ctx.role !== "editor" || EDITOR_HIDDEN_NOTE_KINDS.length === 0) return undefined;
  const kinds = sql.join(
    EDITOR_HIDDEN_NOTE_KINDS.map((k) => sql`${k}`),
    sql`, `,
  );
  const hiddenKind = sql`(
    coalesce(${activityEvents.newValue} ->> 'kind', '') in (${kinds})
    or coalesce(${activityEvents.previousValue} ->> 'kind', '') in (${kinds})
    or coalesce(${activityEvents.metadata} ->> 'kind', '') in (${kinds})
    or coalesce(${activityEvents.metadata} ->> 'noteKind', '') in (${kinds})
  )`;
  return sql`not ((${activityEvents.eventType} like 'note.%' or ${activityEvents.entityType} = 'note') and ${hiddenKind})`;
}

/**
 * `timer.view_others` on the feed (docs/ROLES.md §2.4): `work_session.*`
 * events expose per-person time, so non-admins only get those of their own
 * sessions (they started it, or `metadata.sessionUserId` is them); members
 * additionally on jobs they manage. Editors (even with ⚑teamJobs) never see
 * another person's sessions.
 */
function workSessionPrivacyWhere(db: DbLike, ctx: AuthContext): SQL {
  const me = ctx.userId ?? "";
  const mine = or(eq(activityEvents.actorUserId, me), sql`coalesce(${activityEvents.metadata} ->> 'sessionUserId', '') = ${me}`) as SQL;
  const allowed: SQL[] = [sql`${activityEvents.entityType} <> 'work_session'`, mine];
  if (ctx.role === "photographer") {
    const managed = db
      .select({ one: sql`1` })
      .from(jobs)
      .where(and(eq(jobs.id, activityEvents.jobId), eq(jobs.organisationId, ctx.organisationId), managedJobsWhere(ctx)));
    allowed.push(and(isNotNull(activityEvents.jobId), exists(managed)) as SQL);
  }
  return or(...allowed) as SQL;
}

/** Org + management-visibility + job-visibility predicate over activity_events. */
export function activityScopeWhere(db: DbLike, ctx: AuthContext, viewScope: ViewScope | null = null): SQL {
  const parts: SQL[] = [eq(activityEvents.organisationId, ctx.organisationId)];
  if (!ctx.isSystem && (!ctx.isActive || ctx.role === "client")) parts.push(sql`1 = 0`);
  if (!canSeeManagementEvents(ctx)) parts.push(eq(activityEvents.visibility, "all"));
  const own = ctx.userId ? and(isNull(activityEvents.jobId), eq(activityEvents.actorUserId, ctx.userId)) : sql`1 = 0`;
  if (!ctx.isSystem && !isAdmin(ctx)) {
    const visibleJob = db
      .select({ one: sql`1` })
      .from(jobs)
      .where(and(eq(jobs.id, activityEvents.jobId), visibleJobsWhere(ctx), editorCutoffWhere(ctx, activityEvents.createdAt, activityEvents.actorUserId)));
    parts.push(or(and(isNotNull(activityEvents.jobId), exists(visibleJob)), own) as SQL);
    const notes = notePrivacyWhere(ctx);
    if (notes) parts.push(notes);
    parts.push(workSessionPrivacyWhere(db, ctx));
  }
  const mine = viewScopeWhere(ctx, viewScope);
  if (mine) {
    const myShoot = db
      .select({ one: sql`1` })
      .from(jobs)
      .where(and(eq(jobs.id, activityEvents.jobId), mine));
    parts.push(or(and(isNotNull(activityEvents.jobId), exists(myShoot)), own) as SQL);
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

function subjectIds(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const id = (value as Record<string, unknown>).userId;
  return typeof id === "string" ? [id] : [];
}

/**
 * Assignment reason text is private for editors unless they are the actor or
 * the subject of that assignment (docs/ROLES.md §2.4).
 */
function hidesAssignmentReason(ctx: AuthContext | undefined, e: ActivityEvent): boolean {
  if (!ctx || ctx.isSystem || ctx.role !== "editor") return false;
  if (e.eventType !== "assignment.created" && e.eventType !== "assignment.ended") return false;
  const me = ctx.userId;
  if (me !== null && (e.actorUserId === me || [...subjectIds(e.newValue), ...subjectIds(e.previousValue)].includes(me))) return false;
  return true;
}

export function toFeedItem(row: RawFeedRow, ctx?: AuthContext): ActivityFeedItem {
  const e = row.event;
  const rawMeta = e.metadata && typeof e.metadata === "object" && !Array.isArray(e.metadata) ? (e.metadata as Record<string, unknown>) : {};
  const metadata = hidesAssignmentReason(ctx, e) && "reason" in rawMeta ? { ...rawMeta, reason: null } : rawMeta;
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
export async function listActivity(
  db: DbLike,
  ctx: AuthContext,
  input: unknown = {},
  opts: { /** `pwm_scope` cookie value (the `scope` filter wins). */ scopeCookie?: string | null } = {},
): Promise<Paginated<ActivityFeedItem>> {
  assertCan(ctx, "activity.view_global");
  const f = parseInput(ActivityFiltersSchema, input ?? {});
  const tz = ctx.settings.timezone;
  const limit = f.limit ?? ACTIVITY_DEFAULT_LIMIT;
  const viewScope = viewScopeFor(ctx, { scope: f.scope ?? null, scopeCookie: opts.scopeCookie ?? null });
  const parts: (SQL | undefined)[] = [activityScopeWhere(db, ctx, viewScope)];
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
    items: page.map((r) => toFeedItem(r, ctx)),
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

  return rows.map((r) => toFeedItem(r, ctx));
}
