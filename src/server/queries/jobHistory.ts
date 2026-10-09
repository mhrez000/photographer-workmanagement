/**
 * Job History / Activity / Timeline tabs (ARCHITECTURE.md §5, §10).
 *
 * History = every stage occupancy (`job_status_transitions`) merged with the
 * milestone events in `HISTORY_EVENT_TYPES`, oldest first. Activity = every
 * event for the job (cursor feed). Both drop management-only events for
 * photographers / editors. A job the actor cannot see is a 404.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbLike } from "@/db/index";
import { jobStatusTransitions, workSessions } from "@/db/schema";
import { HISTORY_EVENT_TYPES, STATUS_CATEGORY_META } from "@/lib/constants";
import { durationSeconds } from "@/lib/metrics";
import type { ActivityFeedItem, AuthContext, HistoryEntry, Job, JobStatusTransition, Paginated, StageView, StatusRef, TimelineRow } from "@/lib/types";
import { jobEvents, listActivity } from "./activity";
import { loadStatusRefs, loadUserRefs, loadVisibleJob } from "./scope";
import { getJobTimelineRow } from "./timeline";

/** All transitions of a job (org-scoped), by sequence. */
export function loadTransitions(db: DbLike, ctx: AuthContext, jobId: string): JobStatusTransition[] {
  return db
    .select()
    .from(jobStatusTransitions)
    .where(and(eq(jobStatusTransitions.organisationId, ctx.organisationId), eq(jobStatusTransitions.jobId, jobId)))
    .orderBy(asc(jobStatusTransitions.sequence))
    .all();
}

/** Tracked seconds per transition id (running sessions count up to `now`). */
export function activeSecondsByTransition(db: DbLike, ctx: AuthContext, transitionIds: readonly string[], now: string): Map<string, number> {
  const out = new Map<string, number>();
  if (transitionIds.length === 0) return out;
  const closed = db
    .select({ transitionId: workSessions.transitionId, total: sql<number>`coalesce(sum(${workSessions.durationSeconds}), 0)` })
    .from(workSessions)
    .where(and(eq(workSessions.organisationId, ctx.organisationId), inArray(workSessions.transitionId, [...transitionIds])))
    .groupBy(workSessions.transitionId)
    .all();
  for (const r of closed) out.set(r.transitionId, Number(r.total));
  const running = db
    .select({ transitionId: workSessions.transitionId, startedAt: workSessions.startedAt })
    .from(workSessions)
    .where(and(eq(workSessions.organisationId, ctx.organisationId), inArray(workSessions.transitionId, [...transitionIds]), isNull(workSessions.endedAt)))
    .all();
  for (const r of running) out.set(r.transitionId, (out.get(r.transitionId) ?? 0) + durationSeconds(r.startedAt, null, now));
  return out;
}

function fallbackStatusRef(id: string, name: string, category: StatusRef["category"]): StatusRef {
  return { id, key: id, name, category, colour: STATUS_CATEGORY_META[category].hex, sortOrder: 0 };
}

/** Maps transitions to StageViews (status refs, people, tracked seconds). */
export function toStageViews(db: DbLike, ctx: AuthContext, transitions: readonly JobStatusTransition[], now: string = ctx.now()): StageView[] {
  const statuses = loadStatusRefs(
    db,
    ctx,
    transitions.flatMap((t) => [t.fromStatusId, t.toStatusId]),
  );
  const users = loadUserRefs(
    db,
    ctx,
    transitions.flatMap((t) => [t.actorUserId, t.editorIdAtEntry, t.photographerIdAtEntry]),
  );
  const active = activeSecondsByTransition(
    db,
    ctx,
    transitions.map((t) => t.id),
    now,
  );
  return transitions.map((t) => ({
    id: t.id,
    sequence: t.sequence,
    kind: t.kind,
    fromStatus: t.fromStatusId ? (statuses.get(t.fromStatusId) ?? null) : null,
    toStatus: statuses.get(t.toStatusId) ?? fallbackStatusRef(t.toStatusId, t.statusName, t.toCategory),
    fromCategory: t.fromCategory,
    toCategory: t.toCategory,
    statusName: t.statusName,
    actor: t.actorUserId ? (users.get(t.actorUserId) ?? null) : null,
    reason: t.reason,
    isReopen: t.isReopen,
    isOverride: t.isOverride,
    enteredAt: t.enteredAt,
    exitedAt: t.exitedAt,
    durationSeconds: t.exitedAt !== null && typeof t.durationSeconds === "number" ? t.durationSeconds : durationSeconds(t.enteredAt, t.exitedAt, now),
    isCurrent: t.exitedAt === null,
    editorAtEntry: t.editorIdAtEntry ? (users.get(t.editorIdAtEntry) ?? null) : null,
    photographerAtEntry: t.photographerIdAtEntry ? (users.get(t.photographerIdAtEntry) ?? null) : null,
    activeSeconds: active.get(t.id) ?? 0,
  }));
}

/** StageViews for a job already loaded + permission-checked by the caller. */
export function loadStageViews(db: DbLike, ctx: AuthContext, job: Pick<Job, "id">, now: string = ctx.now()): StageView[] {
  return toStageViews(db, ctx, loadTransitions(db, ctx, job.id), now);
}

/** Stages + milestone events merged oldest → newest (stage first on equal timestamps). */
export function mergeHistory(stages: readonly StageView[], events: readonly ActivityFeedItem[]): HistoryEntry[] {
  const entries: (HistoryEntry & { order: number; seq: number })[] = [
    ...stages.map((stage, i) => ({ at: stage.enteredAt, kind: "stage" as const, stage, order: 0, seq: i })),
    ...events.map((event, i) => ({ at: event.createdAt, kind: "event" as const, event, order: 1, seq: i })),
  ];
  entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order || a.seq - b.seq));
  return entries.map(({ at, kind, stage, event }) => (kind === "stage" ? { at, kind, stage } : { at, kind, event }));
}

/** History tab: stages + milestone events (HISTORY_EVENT_TYPES), management events redacted per role. */
export function getJobHistory(db: DbLike, ctx: AuthContext, jobId: string): HistoryEntry[] {
  const { job } = loadVisibleJob(db, ctx, jobId, "job.view_history");
  const stages = loadStageViews(db, ctx, job);
  const events = jobEvents(db, ctx, job.id, HISTORY_EVENT_TYPES);
  return mergeHistory(stages, events);
}

/** Activity tab: every event of the job, newest first, cursor-paginated (input as listActivity minus jobId). */
export function getJobActivity(db: DbLike, ctx: AuthContext, jobId: string, input: unknown = {}): Paginated<ActivityFeedItem> {
  const { job } = loadVisibleJob(db, ctx, jobId, "job.view_history");
  const base = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return listActivity(db, ctx, { ...base, jobId: job.id });
}

/** Timeline tab: one row with every stage bar of the job. */
export function getJobTimeline(db: DbLike, ctx: AuthContext, jobId: string): TimelineRow {
  return getJobTimelineRow(db, ctx, jobId);
}
