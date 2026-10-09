/**
 * Timeline / Gantt (ARCHITECTURE.md §10 `/workspace/timeline`, job Timeline tab).
 *
 * Stage bars come straight from `job_status_transitions` (time-in-stage
 * ledger). A bar is a bottleneck ("slow stage") per `isSlowStage`: longer
 * than `TIMELINE_BOTTLENECK_FACTOR` × the organisation's usual (median)
 * closed-stage duration for that category, with a 24 h floor on queue stages.
 * Waiting-on-someone-else stages are never flagged (new / ready intake,
 * delivered = waiting on the client, and an assignment before the shoot has
 * happened). Terminal stages (completed / cancelled) are not drawn on the
 * board (they never end); the single-job timeline keeps them.
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, notInArray, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "@/db/index";
import { clients, jobRevisions, jobStatusTransitions, jobs, projects } from "@/db/schema";
import { CATEGORY_GROUPS, type StatusCategory } from "@/lib/constants";
import { addCivilDays, endOfCivilDayIso, startOfCivilDayIso, todayCivil } from "@/lib/dates";
import { durationSeconds } from "@/lib/metrics";
import type { AuthContext, JobStatusTransition, TimelineEvent, TimelineRow, UserRef } from "@/lib/types";
import { NotFoundError } from "@/server/errors";
import { parseInput } from "@/server/services/_shared";
import { jobFiltersWhere, JobListFiltersSchema } from "./jobs";
import { loadOrgSettingsRow, loadUserRefs, loadVisibleJob, orgDayBounds, selectRawJobs, visibleJobsWhere, type RawJobRow } from "./scope";

export const TIMELINE_BOTTLENECK_FACTOR = 2;
/** Minimum baseline for queue stages, so a few hours' wait is never "slow" just because the org is usually quick. */
export const QUEUE_STAGE_FLOOR_SECONDS = 24 * 60 * 60;
/**
 * Minimum baseline for working stages (editing / revision): stage times are
 * wall-clock, so an evening-to-morning stage is never "slow" — the threshold
 * is always at least a day.
 */
export const WORKING_STAGE_FLOOR_SECONDS = 12 * 60 * 60;
/** Never flagged: intake / scheduling (new, ready) and waiting on the client (delivered). */
export const UNFLAGGED_STAGE_CATEGORIES: readonly StatusCategory[] = ["new", "ready", "delivered"];
/** Stages where the job waits in someone's queue (editor to start, reviewer to review, studio to deliver). */
export const QUEUE_STAGE_CATEGORIES: readonly StatusCategory[] = ["assigned", "accepted", "submitted", "review", "resubmitted", "approved"];
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
  /** Job filters (FilterBar), applied in SQL BEFORE the row cap so a match is never cut off. */
  q: JobListFiltersSchema.shape.q,
  /** The job's CURRENT editor ("none" = unassigned); `editorId` above filters bars by who held them. */
  currentEditorId: JobListFiltersSchema.shape.editorId,
  photographerId: JobListFiltersSchema.shape.photographerId,
  priority: JobListFiltersSchema.shape.priority,
});
export type TimelineQueryInput = z.input<typeof TimelineQuerySchema>;

/** Median of a list of numbers (0 for an empty list). */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Usual closed-stage seconds per category: the median (robust to the long
 * tail of parked jobs), floored at 24 h for queue stages and 12 h for working
 * stages. Categories that are never flagged get no baseline.
 */
export function stageBaselines(durations: Partial<Record<StatusCategory, readonly number[]>>): Partial<Record<StatusCategory, number>> {
  const out: Partial<Record<StatusCategory, number>> = {};
  for (const [category, values] of Object.entries(durations) as [StatusCategory, readonly number[]][]) {
    if (UNFLAGGED_STAGE_CATEGORIES.includes(category) || values.length === 0) continue;
    const m = median(values);
    const baseline = Math.max(m, QUEUE_STAGE_CATEGORIES.includes(category) ? QUEUE_STAGE_FLOOR_SECONDS : WORKING_STAGE_FLOOR_SECONDS);
    if (baseline > 0) out[category] = baseline;
  }
  return out;
}

/** Usual (median, floored) closed-stage seconds per category across the organisation. */
export function orgCategoryBaselines(db: DbLike, ctx: AuthContext): Partial<Record<StatusCategory, number>> {
  const rows = db
    .select({ category: jobStatusTransitions.toCategory, seconds: jobStatusTransitions.durationSeconds })
    .from(jobStatusTransitions)
    .where(
      and(
        eq(jobStatusTransitions.organisationId, ctx.organisationId),
        isNotNull(jobStatusTransitions.exitedAt),
        isNotNull(jobStatusTransitions.durationSeconds),
        notInArray(jobStatusTransitions.toCategory, [...UNFLAGGED_STAGE_CATEGORIES]),
      ),
    )
    .all();
  const durations: Partial<Record<StatusCategory, number[]>> = {};
  for (const r of rows) if (r.seconds !== null) (durations[r.category] ??= []).push(Number(r.seconds));
  return stageBaselines(durations);
}

/** The job dates the slow-stage rule reads. */
export interface StageJobDates {
  shootDate: string | null;
  dueDate: string | null;
  reviewDueDate: string | null;
  deliveryDueDate: string | null;
  /** Due date of the job's open revision request (revision stages work towards this, not the original editing deadline). */
  openRevisionDueDate?: string | null;
}

/**
 * The deadline a stage works towards: the open revision's due date for a
 * revision, editing due for the other editor stages, review due for reviewer
 * stages, delivery due once approved.
 */
export function relevantStageDueDate(category: StatusCategory, job: StageJobDates): string | null {
  if (category === "revision") return job.openRevisionDueDate ?? null;
  if (CATEGORY_GROUPS.EDITOR_HOLDS.includes(category)) return job.dueDate;
  if (CATEGORY_GROUPS.REVIEWER_HOLDS.includes(category)) return job.reviewDueDate;
  if (category === "approved") return job.deliveryDueDate;
  return null;
}

const msOf = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const v = Date.parse(iso);
  return Number.isFinite(v) ? v : null;
};

type StageLike = Pick<JobStatusTransition, "toCategory" | "enteredAt" | "exitedAt">;

/**
 * Seconds of a stage that count towards "slow". An assignment waiting for the
 * shoot to happen is not slow: assigned / accepted stages count from the
 * shoot date onwards.
 */
export function measuredStageSeconds(t: StageLike, job: StageJobDates, now: string): number {
  const start = msOf(t.enteredAt);
  const end = msOf(t.exitedAt ?? now);
  if (start === null || end === null) return 0;
  const shoot = CATEGORY_GROUPS.AWAITING_EDITOR.includes(t.toCategory) ? msOf(job.shootDate) : null;
  const from = shoot !== null ? Math.max(start, shoot) : start;
  return Math.max(0, Math.floor((end - from) / 1000));
}

/**
 * Slow-stage rule (Timeline bottleneck outline).
 * - Never: new / ready / delivered, or an assignment wholly before the shoot.
 * - Closed stage: measured time > factor × the usual time for its category.
 * - Current stage: that same threshold, or past the deadline it works towards.
 */
export function isSlowStage(t: StageLike, job: StageJobDates, baselines: Partial<Record<StatusCategory, number>>, now: string): boolean {
  if (UNFLAGGED_STAGE_CATEGORIES.includes(t.toCategory)) return false;
  const measured = measuredStageSeconds(t, job, now);
  if (measured <= 0) return false;
  const baseline = baselines[t.toCategory];
  const overThreshold = baseline !== undefined && baseline > 0 && measured > TIMELINE_BOTTLENECK_FACTOR * baseline;
  if (t.exitedAt !== null) return overThreshold;
  const due = msOf(relevantStageDueDate(t.toCategory, job));
  const nowMs = msOf(now);
  return overThreshold || (due !== null && nowMs !== null && due < nowMs);
}

export function toTimelineEvent(
  job: { id: string; jobNumber: string; name: string } & StageJobDates,
  t: JobStatusTransition,
  users: ReadonlyMap<string, UserRef>,
  baselines: Partial<Record<StatusCategory, number>>,
  now: string,
): TimelineEvent {
  const duration = t.exitedAt !== null && typeof t.durationSeconds === "number" ? t.durationSeconds : durationSeconds(t.enteredAt, t.exitedAt, now);
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
    isBottleneck: isSlowStage(t, job, baselines, now),
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
/** `jobs.id IN (…)` for the FilterBar filters (search, current editor, photographer, priority); undefined when none is set. */
function jobFilterSubquery(db: DbLike, ctx: AuthContext, q: z.output<typeof TimelineQuerySchema>): SQL | undefined {
  if (!q.q && !q.currentEditorId?.length && !q.photographerId?.length && !q.priority?.length) return undefined;
  const filters = JobListFiltersSchema.parse({});
  const bounds = orgDayBounds(ctx, ctx.now(), loadOrgSettingsRow(db, ctx)?.weekStartsOn ?? 1);
  const where = jobFiltersWhere(ctx, { ...filters, q: q.q, editorId: q.currentEditorId, photographerId: q.photographerId, priority: q.priority }, bounds, {
    defaultHideCancelled: false,
  });
  const ids = db
    .select({ id: jobs.id })
    .from(jobs)
    .leftJoin(clients, eq(clients.id, jobs.clientId))
    .leftJoin(projects, eq(projects.id, jobs.projectId))
    .where(and(eq(jobs.organisationId, ctx.organisationId), where));
  return inArray(jobStatusTransitions.jobId, ids);
}

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
    jobFilterSubquery(db, ctx, q),
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
  const baselines = orgCategoryBaselines(db, ctx);
  const revisionDue = openRevisionDueDates(db, ctx, jobIds);

  const rows: TimelineRow[] = [];
  for (const id of jobIds) {
    const raw = byId.get(id);
    if (!raw) continue;
    const dates = { ...raw.job, openRevisionDueDate: revisionDue.get(id) ?? null };
    rows.push({
      job: rowJob(raw),
      segments: transitions.filter((t) => t.jobId === id).map((t) => toTimelineEvent(dates, t, users, baselines, now)),
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
  const baselines = orgCategoryBaselines(db, ctx);
  const dates = { ...job, openRevisionDueDate: openRevisionDueDates(db, ctx, [job.id]).get(job.id) ?? null };
  return {
    job: rowJob(raw),
    segments: transitions.map((t) => toTimelineEvent(dates, t, users, baselines, now)),
  };
}

/** Due date of each job's open (unresolved) revision request — the latest one when several are open. */
function openRevisionDueDates(db: DbLike, ctx: AuthContext, jobIds: readonly string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (jobIds.length === 0) return out;
  const rows = db
    .select({ jobId: jobRevisions.jobId, dueDate: jobRevisions.dueDate })
    .from(jobRevisions)
    .where(and(eq(jobRevisions.organisationId, ctx.organisationId), inArray(jobRevisions.jobId, [...jobIds]), isNull(jobRevisions.resolvedAt)))
    .orderBy(asc(jobRevisions.revisionNumber))
    .all();
  for (const r of rows) out.set(r.jobId, r.dueDate);
  return out;
}
