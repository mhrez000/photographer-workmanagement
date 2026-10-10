/**
 * My Work queue (ARCHITECTURE.md §10 `/workspace/my`).
 *
 * Whose jobs (docs/ROLES.md §8 — always personal, never the scope switch):
 * editors → jobs they currently hold (`editor_id = me`); photographers
 * (admins included) → jobs they shoot or created as a photographer; admins
 * additionally get "Reviews waiting for me": reviewer-held jobs only an admin
 * can review (`needsAdminReviewWhere`). Only ACTIVE jobs; editors do not see
 * DONE (approved / delivered) jobs in their queue. Clients get nothing.
 *
 * Sections are exclusive; a job lands in the first that matches:
 *   Overdue → Paused → Waiting for Review → Revision Required →
 *   Due Today → Due Tomorrow → Upcoming (later or no due date).
 * Deadlines are judged in the organisation timezone.
 */
import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { first, type DbLike } from "@/db/index";
import { jobNotes, jobs, workSessions } from "@/db/schema";
import { CATEGORY_GROUPS, type NoteKind } from "@/lib/constants";
import type { AuthContext, JobRow, MyWorkQueue, WorkSessionView } from "@/lib/types";
import { isDeadlineBound, isReviewerHolds } from "@/lib/workflow";
import { toWorkSessionView } from "./jobDetail";
import { isAdmin, managedJobsWhere } from "@/server/auth/permissions";
import {
  categoryIn,
  loadOrgSettingsRow,
  loadStatusRefs,
  loadUserRefs,
  needsAdminReviewWhere,
  orgDayBounds,
  priorityOrderSql,
  selectJobRows,
  visibleJobsWhere,
  type OrgDayBounds,
} from "./scope";

export const MY_WORK_MAX_JOBS = 500;

export type MyWorkSection = Exclude<keyof MyWorkQueue, "runningSession">;

/** WHERE for "my" jobs per persona (see file header). */
export function myJobsWhere(ctx: AuthContext): SQL {
  const me = ctx.userId;
  if (!me || ctx.isSystem) return sql`1 = 0`;
  if (ctx.role === "editor") {
    return and(eq(jobs.editorId, me), categoryIn(CATEGORY_GROUPS.DEADLINE_BOUND)) as SQL;
  }
  if (ctx.role !== "photographer") return sql`1 = 0`;
  const mine = managedJobsWhere(ctx);
  // Admins: + reviews only an admin can do, regardless of the view scope (§8).
  const reviews = isAdmin(ctx) ? and(categoryIn(CATEGORY_GROUPS.REVIEWER_HOLDS), needsAdminReviewWhere()) : undefined;
  return and(reviews ? or(mine, reviews) : mine, categoryIn(CATEGORY_GROUPS.ACTIVE)) as SQL;
}

/** Section of a job row (exclusive, first match wins). */
export function myWorkSectionOf(row: JobRow, bounds: OrgDayBounds): MyWorkSection {
  if (row.isOverdue) return "overdue";
  if (row.isPaused) return "paused";
  if (isReviewerHolds(row.statusCategory)) return "waitingForReview";
  if (row.statusCategory === "revision") return "revisionRequired";
  if (row.isDueToday) return "dueToday";
  if (isDeadlineBound(row.statusCategory) && row.dueDate !== null && row.dueDate > bounds.endOfToday && row.dueDate <= bounds.endOfTomorrow) {
    return "dueTomorrow";
  }
  return "upcoming";
}

/** The actor's running timer (any job), or null. */
export async function getRunningSession(db: DbLike, ctx: AuthContext): Promise<WorkSessionView | null> {
  if (!ctx.userId) return null;
  const s = await first(
    db
      .select()
      .from(workSessions)
      .where(and(eq(workSessions.organisationId, ctx.organisationId), eq(workSessions.userId, ctx.userId), isNull(workSessions.endedAt)))
      .orderBy(desc(workSessions.startedAt), asc(workSessions.id))
      .limit(1),
  );
  if (!s) return null;
  const users = await loadUserRefs(db, ctx, [s.userId]);
  const status = (await loadStatusRefs(db, ctx, [s.statusIdAtStart])).get(s.statusIdAtStart);
  return toWorkSessionView(s, (id) => (id ? (users.get(id) ?? null) : null), status?.name ?? s.categoryAtStart, ctx.now());
}

export async function getMyWorkQueue(db: DbLike, ctx: AuthContext): Promise<MyWorkQueue> {
  const now = ctx.now();
  const bounds = orgDayBounds(ctx, now, (await loadOrgSettingsRow(db, ctx))?.weekStartsOn ?? 1);
  const rows = await selectJobRows(db, ctx, {
    where: myJobsWhere(ctx),
    orderBy: [sql`${jobs.dueDate} asc nulls last`, sql`${priorityOrderSql()} desc`, sql`${jobs.statusEnteredAt} asc`, sql`${jobs.id} asc`],
    limit: MY_WORK_MAX_JOBS,
  });
  const queue: MyWorkQueue = {
    dueToday: [],
    dueTomorrow: [],
    upcoming: [],
    overdue: [],
    waitingForReview: [],
    revisionRequired: [],
    paused: [],
    runningSession: await getRunningSession(db, ctx),
  };
  for (const row of rows) queue[myWorkSectionOf(row, bounds)].push(row);
  return queue;
}

/** Latest visible note of a job, for the My Work card preview. */
export interface MyWorkNotePreview {
  kind: NoteKind;
  body: string;
  isPinned: boolean;
  updatedAt: string;
}

/**
 * Kinds a viewer may read as a SQL predicate over `job_notes` joined to `jobs`
 * (the `note.read` rule): admins every kind; team members every kind but
 * `internal` unless they manage the job; editors never `internal` / `client`.
 */
function readableNoteKindsWhere(ctx: AuthContext): SQL | undefined {
  if (isAdmin(ctx)) return undefined;
  if (ctx.role === "photographer") return or(sql`${jobNotes.kind} <> 'internal'`, managedJobsWhere(ctx)) as SQL;
  return notInArray(jobNotes.kind, ["internal", "client"]);
}

/**
 * One note preview per job (pinned first, then most recently edited; archived
 * notes skipped), only notes the viewer may read (`note.read`) on jobs they
 * can see. Callers pass job ids they loaded through `getMyWorkQueue`.
 */
export async function getMyWorkNotePreviews(db: DbLike, ctx: AuthContext, jobIds: readonly string[]): Promise<Record<string, MyWorkNotePreview>> {
  const out: Record<string, MyWorkNotePreview> = {};
  const ids = [...new Set(jobIds)].slice(0, MY_WORK_MAX_JOBS);
  if (ids.length === 0) return out;
  const rows = await db
    .select({ jobId: jobNotes.jobId, kind: jobNotes.kind, body: jobNotes.body, isPinned: jobNotes.isPinned, updatedAt: jobNotes.updatedAt })
    .from(jobNotes)
    .innerJoin(jobs, eq(jobs.id, jobNotes.jobId))
    .where(
      and(
        eq(jobNotes.organisationId, ctx.organisationId),
        inArray(jobNotes.jobId, ids),
        isNull(jobNotes.archivedAt),
        visibleJobsWhere(ctx),
        readableNoteKindsWhere(ctx),
      ),
    )
    .orderBy(desc(jobNotes.isPinned), desc(jobNotes.updatedAt), asc(jobNotes.id));

  for (const r of rows) {
    if (out[r.jobId]) continue;
    out[r.jobId] = { kind: r.kind, body: r.body, isPinned: r.isPinned, updatedAt: r.updatedAt };
  }
  return out;
}
