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
import { ANOTHER_EDITOR, editorReadCutoff, loadEditorAssignmentFacts, loadStatusRefs, loadUserRefs, loadVisibleJob } from "./scope";
import { getJobTimelineRow } from "./timeline";

/** All transitions of a job (org-scoped), by sequence. */
export async function loadTransitions(db: DbLike, ctx: AuthContext, jobId: string): Promise<JobStatusTransition[]> {
  return db
    .select()
    .from(jobStatusTransitions)
    .where(and(eq(jobStatusTransitions.organisationId, ctx.organisationId), eq(jobStatusTransitions.jobId, jobId)))
    .orderBy(asc(jobStatusTransitions.sequence));
}

/** Tracked seconds per transition id (running sessions count up to `now`). */
export async function activeSecondsByTransition(db: DbLike, ctx: AuthContext, transitionIds: readonly string[], now: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (transitionIds.length === 0) return out;
  const closed = await db
    .select({ transitionId: workSessions.transitionId, total: sql<number>`coalesce(sum(${workSessions.durationSeconds}), 0)`.mapWith(Number) })
    .from(workSessions)
    .where(and(eq(workSessions.organisationId, ctx.organisationId), inArray(workSessions.transitionId, [...transitionIds])))
    .groupBy(workSessions.transitionId);
  for (const r of closed) out.set(r.transitionId, Number(r.total));
  const running = await db
    .select({ transitionId: workSessions.transitionId, startedAt: workSessions.startedAt })
    .from(workSessions)
    .where(and(eq(workSessions.organisationId, ctx.organisationId), inArray(workSessions.transitionId, [...transitionIds]), isNull(workSessions.endedAt)));
  for (const r of running) out.set(r.transitionId, (out.get(r.transitionId) ?? 0) + durationSeconds(r.startedAt, null, now));
  return out;
}

function fallbackStatusRef(id: string, name: string, category: StatusRef["category"]): StatusRef {
  return { id, key: id, name, category, colour: STATUS_CATEGORY_META[category].hex, sortOrder: 0 };
}

/** Maps transitions to StageViews (status refs, people, tracked seconds). */
export async function toStageViews(db: DbLike, ctx: AuthContext, transitions: readonly JobStatusTransition[], now: string = ctx.now()): Promise<StageView[]> {
  const statuses = await loadStatusRefs(
    db,
    ctx,
    transitions.flatMap((t) => [t.fromStatusId, t.toStatusId]),
  );
  const users = await loadUserRefs(
    db,
    ctx,
    transitions.flatMap((t) => [t.actorUserId, t.editorIdAtEntry, t.photographerIdAtEntry]),
  );
  const active = await activeSecondsByTransition(
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
export async function loadStageViews(db: DbLike, ctx: AuthContext, job: Pick<Job, "id">, now: string = ctx.now()): Promise<StageView[]> {
  return toStageViews(db, ctx, await loadTransitions(db, ctx, job.id), now);
}

/**
 * Stages + milestone events merged oldest → newest (stage first on equal
 * timestamps). Ties inside each kind fall back to an insertion key — the
 * transition `sequence` for stages, the input position for events (which
 * `jobEvents` returns in `rowid` = insertion order) — never to the random id,
 * so e.g. `assignment.ended` always precedes the `assignment.created` written
 * in the same millisecond.
 */
export function mergeHistory(stages: readonly StageView[], events: readonly ActivityFeedItem[]): HistoryEntry[] {
  const entries: (HistoryEntry & { order: number; seq: number })[] = [
    ...stages.map((stage) => ({ at: stage.enteredAt, kind: "stage" as const, stage, order: 0, seq: stage.sequence })),
    ...events.map((event, i) => ({ at: event.createdAt, kind: "event" as const, event, order: 1, seq: i })),
  ];
  entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order || a.seq - b.seq));
  return entries.map(({ at, kind, stage, event }) => (kind === "stage" ? { at, kind, stage } : { at, kind, event }));
}

/**
 * Stages under the editor read cut-off (docs/ROLES.md §2.3): stages entered
 * after the cut-off keep their status and dates but hide who acted and who
 * held the job (unless it was the viewer).
 */
export function redactStagesAfterCutoff(stages: readonly StageView[], cutoff: string | null, me: string | null): StageView[] {
  if (cutoff === null) return [...stages];
  return stages.map((st) => {
    if (st.enteredAt < cutoff) return st; // the handover stage itself (entered at the cut-off) already names the next holder
    return {
      ...st,
      actor: st.actor && st.actor.id === me ? st.actor : null,
      reason: st.actor && st.actor.id === me ? st.reason : null,
      editorAtEntry: st.editorAtEntry && st.editorAtEntry.id !== me ? ANOTHER_EDITOR : st.editorAtEntry,
    };
  });
}

/** History tab: stages + milestone events (HISTORY_EVENT_TYPES), management events redacted per persona, editor cut-off applied. */
export async function getJobHistory(db: DbLike, ctx: AuthContext, jobId: string): Promise<HistoryEntry[]> {
  const { job, ref } = await loadVisibleJob(db, ctx, jobId, "job.view_history");
  const cutoff = editorReadCutoff(ctx, ref, (await loadEditorAssignmentFacts(db, ctx, [job.id])).get(job.id) ?? []);
  const stages = redactStagesAfterCutoff(await loadStageViews(db, ctx, job), cutoff, ctx.userId);
  const events = await jobEvents(db, ctx, job.id, HISTORY_EVENT_TYPES);
  return mergeHistory(stages, events);
}

/** Activity tab: every event of the job, newest first, cursor-paginated (input as listActivity minus jobId). */
export async function getJobActivity(db: DbLike, ctx: AuthContext, jobId: string, input: unknown = {}): Promise<Paginated<ActivityFeedItem>> {
  const { job } = await loadVisibleJob(db, ctx, jobId, "job.view_history");
  const base = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return listActivity(db, ctx, { ...base, jobId: job.id });
}

/** Timeline tab: one row with every stage bar of the job. */
export async function getJobTimeline(db: DbLike, ctx: AuthContext, jobId: string): Promise<TimelineRow> {

  return getJobTimelineRow(db, ctx, jobId);
}
