/**
 * My Work queue (ARCHITECTURE.md §10 `/workspace/my`).
 *
 * Whose jobs: editors → jobs they currently hold (`editor_id = me`);
 * photographers → own jobs (photographer or creator); owners / managers →
 * jobs where they are photographer, editor or creator. Only ACTIVE jobs;
 * editors do not see DONE (approved / delivered) jobs in their queue.
 *
 * Sections are exclusive; a job lands in the first that matches:
 *   Overdue → Paused → Waiting for Review → Revision Required →
 *   Due Today → Due Tomorrow → Upcoming (later or no due date).
 * Deadlines are judged in the organisation timezone.
 */
import { and, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { DbLike } from "@/db/index";
import { jobNotes, jobs, workSessions } from "@/db/schema";
import { CATEGORY_GROUPS, MANAGEMENT_ROLES, type NoteKind } from "@/lib/constants";
import type { AuthContext, JobRow, MyWorkQueue, WorkSessionView } from "@/lib/types";
import { isDeadlineBound, isReviewerHolds } from "@/lib/workflow";
import { toWorkSessionView } from "./jobDetail";
import { categoryIn, loadOrgSettingsRow, loadStatusRefs, loadUserRefs, orgDayBounds, priorityOrderSql, selectJobRows, type OrgDayBounds } from "./scope";

export const MY_WORK_MAX_JOBS = 500;

export type MyWorkSection = Exclude<keyof MyWorkQueue, "runningSession">;

/** WHERE for "my" jobs per role (see file header). */
export function myJobsWhere(ctx: AuthContext): SQL {
  const me = ctx.userId;
  if (!me) return sql`1 = 0`;
  if (ctx.role === "editor") {
    return and(eq(jobs.editorId, me), categoryIn(CATEGORY_GROUPS.DEADLINE_BOUND)) as SQL;
  }
  const mine =
    ctx.role === "photographer"
      ? or(eq(jobs.photographerId, me), eq(jobs.createdByUserId, me))
      : or(eq(jobs.photographerId, me), eq(jobs.editorId, me), eq(jobs.createdByUserId, me));
  return and(mine, categoryIn(CATEGORY_GROUPS.ACTIVE)) as SQL;
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
export function getRunningSession(db: DbLike, ctx: AuthContext): WorkSessionView | null {
  if (!ctx.userId) return null;
  const s = db
    .select()
    .from(workSessions)
    .where(and(eq(workSessions.organisationId, ctx.organisationId), eq(workSessions.userId, ctx.userId), isNull(workSessions.endedAt)))
    .orderBy(desc(workSessions.startedAt))
    .get();
  if (!s) return null;
  const users = loadUserRefs(db, ctx, [s.userId]);
  const status = loadStatusRefs(db, ctx, [s.statusIdAtStart]).get(s.statusIdAtStart);
  return toWorkSessionView(s, (id) => (id ? (users.get(id) ?? null) : null), status?.name ?? s.categoryAtStart, ctx.now());
}

export function getMyWorkQueue(db: DbLike, ctx: AuthContext): MyWorkQueue {
  const now = ctx.now();
  const bounds = orgDayBounds(ctx, now, loadOrgSettingsRow(db, ctx)?.weekStartsOn ?? 1);
  const rows = selectJobRows(db, ctx, {
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
    runningSession: getRunningSession(db, ctx),
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
 * One note preview per job (pinned first, then most recently edited; archived
 * notes skipped). Internal notes are only previewed for owners/managers — the
 * same rule as `note.read` for non-management roles. Callers pass job ids they
 * already loaded through `getMyWorkQueue` (so visibility is already scoped).
 */
export function getMyWorkNotePreviews(db: DbLike, ctx: AuthContext, jobIds: readonly string[]): Record<string, MyWorkNotePreview> {
  const out: Record<string, MyWorkNotePreview> = {};
  const ids = [...new Set(jobIds)].slice(0, MY_WORK_MAX_JOBS);
  if (ids.length === 0) return out;
  const rows = db
    .select({ jobId: jobNotes.jobId, kind: jobNotes.kind, body: jobNotes.body, isPinned: jobNotes.isPinned, updatedAt: jobNotes.updatedAt })
    .from(jobNotes)
    .where(
      and(
        eq(jobNotes.organisationId, ctx.organisationId),
        inArray(jobNotes.jobId, ids),
        isNull(jobNotes.archivedAt),
        MANAGEMENT_ROLES.includes(ctx.role) ? undefined : ne(jobNotes.kind, "internal"),
      ),
    )
    .orderBy(desc(jobNotes.isPinned), desc(jobNotes.updatedAt))
    .all();
  for (const r of rows) {
    if (out[r.jobId]) continue;
    out[r.jobId] = { kind: r.kind, body: r.body, isPinned: r.isPinned, updatedAt: r.updatedAt };
  }
  return out;
}
