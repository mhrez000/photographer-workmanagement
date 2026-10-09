/**
 * Timeline / Gantt (ARCHITECTURE.md §10 `/workspace/timeline`, job Timeline tab).
 *
 * Stage bars come straight from `job_status_transitions` (time-in-stage
 * ledger). A bar is a bottleneck when its duration exceeds
 * `TIMELINE_BOTTLENECK_FACTOR` × the organisation's average closed-stage
 * duration for that category. Terminal stages (completed / cancelled) are
 * not drawn on the board (they never end); the single-job timeline keeps them.
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "@/db/index";
import { jobStatusTransitions, jobs } from "@/db/schema";
import { CATEGORY_GROUPS, type StatusCategory } from "@/lib/constants";
import { addCivilDays, endOfCivilDayIso, startOfCivilDayIso, todayCivil } from "@/lib/dates";
import { durationSeconds } from "@/lib/metrics";
import type { AuthContext, JobStatusTransition, TimelineEvent, TimelineRow, UserRef } from "@/lib/types";
import { NotFoundError } from "@/server/errors";
import { parseInput } from "@/server/services/_shared";
import { loadUserRefs, loadVisibleJob, selectRawJobs, visibleJobsWhere, type RawJobRow } from "./scope";

export const TIMELINE_BOTTLENECK_FACTOR = 2;
const DEFAULT_PAST_DAYS = 14;
const DEFAULT_FUTURE_DAYS = 14;
const MAX_ROWS = 500;

const one = <T extends z.ZodType>(item: T) => z.preprocess((v) => (Array.isArray(v) ? v[0] : v === "" ? undefined : v), item);
const bound = one(z.string().regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, "Expected YYYY-MM-DD or an ISO timestamp").optional());

export const TimelineQuerySchema = z.object({
  /** Civil date (inclusive) or ISO instant. Default: today − 14 days. */
  from: bound,
  /** Civil date (inclusive) or ISO instant (exclusive). Default: today + 14 days. */
  to: bound,
  groupBy: one(z.enum(["editor", "photographer", "none"]).default("editor")),
  /** Only bars held by this editor (editor_id_at_entry). */
  editorId: one(z.string().min(1).optional()),
  jobId: one(z.string().min(1).optional()),
});
export type TimelineQueryInput = z.input<typeof TimelineQuerySchema>;

/** Average closed-stage seconds per category across the organisation. */
export function orgCategoryAverages(db: DbLike, ctx: AuthContext): Partial<Record<StatusCategory, number>> {
  const rows = db
    .select({ category: jobStatusTransitions.toCategory, avg: sql<number>`avg(${jobStatusTransitions.durationSeconds})` })
    .from(jobStatusTransitions)
    .where(and(eq(jobStatusTransitions.organisationId, ctx.organisationId), isNotNull(jobStatusTransitions.exitedAt)))
    .groupBy(jobStatusTransitions.toCategory)
    .all();
  const out: Partial<Record<StatusCategory, number>> = {};
  for (const r of rows) if (r.avg !== null) out[r.category] = Number(r.avg);
  return out;
}

export function toTimelineEvent(
  job: { id: string; jobNumber: string; name: string },
  t: JobStatusTransition,
  users: ReadonlyMap<string, UserRef>,
  averages: Partial<Record<StatusCategory, number>>,
  now: string,
): TimelineEvent {
  const duration = t.exitedAt !== null && typeof t.durationSeconds === "number" ? t.durationSeconds : durationSeconds(t.enteredAt, t.exitedAt, now);
  const avg = averages[t.toCategory];
  return {
    jobId: job.id,
    jobNumber: job.jobNumber,
    jobName: job.name,
    stageId: t.id,
    category: t.toCategory,
    statusName: t.statusName,
    startAt: t.enteredAt,
    endAt: t.exitedAt,
    durationSeconds: duration,
    editor: t.editorIdAtEntry ? (users.get(t.editorIdAtEntry) ?? null) : null,
    isBottleneck: avg !== undefined && avg > 0 && duration > TIMELINE_BOTTLENECK_FACTOR * avg,
    isCurrent: t.exitedAt === null,
  };
}

function rowJob(raw: RawJobRow): TimelineRow["job"] {
  return {
    id: raw.job.id,
    jobNumber: raw.job.jobNumber,
    name: raw.job.name,
    priority: raw.job.priority,
    dueDate: raw.job.dueDate,
    editor: raw.editor ? { ...raw.editor } : null,
    photographer: raw.photographer ? { ...raw.photographer } : null,
    statusCategory: raw.job.statusCategory,
    client: { id: raw.client.id, name: raw.client.name },
    project: { id: raw.project.id, name: raw.project.name },
  };
}

function rangeOf(ctx: AuthContext, from: string | undefined, to: string | undefined, now: string): { from: string; to: string } {
  const tz = ctx.settings.timezone;
  const today = todayCivil(tz, new Date(now));
  const civil = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  const f = from ? (civil(from) ? startOfCivilDayIso(from, tz) : from) : startOfCivilDayIso(addCivilDays(today, -DEFAULT_PAST_DAYS), tz);
  const t = to ? (civil(to) ? endOfCivilDayIso(to, tz) : to) : endOfCivilDayIso(addCivilDays(today, DEFAULT_FUTURE_DAYS), tz);
  return { from: f, to: t };
}

/** Gantt rows for visible jobs with a (non-terminal) stage overlapping [from, to] (`to` is an end-of-day instant). */
export function getTimelineRows(db: DbLike, ctx: AuthContext, input: unknown = {}): TimelineRow[] {
  const q = parseInput(TimelineQuerySchema, input ?? {});
  const now = ctx.now();
  const range = rangeOf(ctx, q.from, q.to, now);

  const conditions: (SQL | undefined)[] = [
    eq(jobStatusTransitions.organisationId, ctx.organisationId),
    visibleJobsWhere(ctx),
    lte(jobStatusTransitions.enteredAt, range.to),
    or(isNull(jobStatusTransitions.exitedAt), gt(jobStatusTransitions.exitedAt, range.from)),
    notInArray(jobStatusTransitions.toCategory, [...CATEGORY_GROUPS.TERMINAL]),
    q.editorId ? eq(jobStatusTransitions.editorIdAtEntry, q.editorId) : undefined,
    q.jobId ? eq(jobStatusTransitions.jobId, q.jobId) : undefined,
  ];
  const transitions = db
    .select({ t: jobStatusTransitions })
    .from(jobStatusTransitions)
    .innerJoin(jobs, eq(jobs.id, jobStatusTransitions.jobId))
    .where(and(...conditions))
    .orderBy(asc(jobStatusTransitions.jobId), asc(jobStatusTransitions.sequence))
    .all()
    .map((r) => r.t);

  const jobIds = [...new Set(transitions.map((t) => t.jobId))].slice(0, MAX_ROWS);
  if (jobIds.length === 0) return [];
  const raws = selectRawJobs(db, ctx, { where: inArray(jobs.id, jobIds) });
  const byId = new Map(raws.map((r) => [r.job.id, r]));
  const users = loadUserRefs(
    db,
    ctx,
    transitions.map((t) => t.editorIdAtEntry),
  );
  const averages = orgCategoryAverages(db, ctx);

  const rows: TimelineRow[] = [];
  for (const id of jobIds) {
    const raw = byId.get(id);
    if (!raw) continue;
    rows.push({
      job: rowJob(raw),
      segments: transitions.filter((t) => t.jobId === id).map((t) => toTimelineEvent(raw.job, t, users, averages, now)),
    });
  }

  const groupName = (r: TimelineRow): string | null =>
    q.groupBy === "editor" ? (r.job.editor?.name ?? null) : q.groupBy === "photographer" ? (r.job.photographer?.name ?? null) : "";
  rows.sort((a, b) => {
    const ga = groupName(a);
    const gb = groupName(b);
    if (ga !== gb) {
      if (ga === null) return 1;
      if (gb === null) return -1;
      const c = ga.localeCompare(gb);
      if (c !== 0) return c;
    }
    return (a.segments[0]?.startAt ?? "").localeCompare(b.segments[0]?.startAt ?? "");
  });
  return rows;
}

/** Every stage of one job as a timeline row (job Timeline tab); 404 when not visible. */
export function getJobTimelineRow(db: DbLike, ctx: AuthContext, jobId: string): TimelineRow {
  const { job } = loadVisibleJob(db, ctx, jobId, "job.view_history");
  const raw = selectRawJobs(db, ctx, { where: eq(jobs.id, job.id), limit: 1 })[0];
  if (!raw) throw new NotFoundError("Job");
  const transitions = db
    .select()
    .from(jobStatusTransitions)
    .where(and(eq(jobStatusTransitions.organisationId, ctx.organisationId), eq(jobStatusTransitions.jobId, job.id)))
    .orderBy(asc(jobStatusTransitions.sequence))
    .all();
  const now = ctx.now();
  const users = loadUserRefs(
    db,
    ctx,
    transitions.map((t) => t.editorIdAtEntry),
  );
  const averages = orgCategoryAverages(db, ctx);
  return {
    job: rowJob(raw),
    segments: transitions.map((t) => toTimelineEvent(job, t, users, averages, now)),
  };
}
