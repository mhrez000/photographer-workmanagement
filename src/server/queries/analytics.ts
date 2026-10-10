/**
 * Insights / analytics (ARCHITECTURE.md §8, §9 `/api/analytics/*`, §10
 * `/insights/analytics`, My Performance).
 *
 * Organisation-wide aggregates for analytics viewers (analytics.view = O/M,
 * photographers with can_view_analytics). Per-editor numbers follow the
 * ledgers: approvals are credited to the approving editor and editing time to
 * `editor_id_at_entry`, so a mid-stage reassignment (reattribution row) splits
 * the stage between the two editors.
 *
 * Definitions:
 *   - completed / trend.completed: completedInRange (latest completion only)
 *   - outstanding / overdue: right now (KPI semantics)
 *   - completionRate: of the jobs created in range (cancelled excluded), the
 *     share now in a DONE category (approved / delivered / completed)
 *   - capacityHours / loadHours: Σ resolved capacity and Σ workload score over
 *     active editors
 *   - trend buckets: daily for ranges ≤ 31 days, else 7-day buckets from the
 *     range start; `date` = bucket start (civil, org tz)
 */
import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import type { DbLike } from "@/db/index";
import { clients, jobTypes, jobs } from "@/db/schema";
import { CATEGORY_GROUPS } from "@/lib/constants";
import { addCivilDays, civilDate, civilDiffDays, startOfCivilDayIso } from "@/lib/dates";
import { onTimeRate, revisionRate, turnaroundSeconds, type Range, type TransitionLike } from "@/lib/metrics";
import type {
  AnalyticsOverview,
  AuthContext,
  EditorAnalytics,
  MyAnalytics,
  PerformanceRow,
  PhotographerPerformanceRow,
  ResolvedRange,
  TrendPoint,
  UserRef,
} from "@/lib/types";
import { isDeadlineBound } from "@/lib/workflow";
import { assertCan } from "@/server/auth/permissions";
import { loadUserInOrg } from "@/server/services/_shared";
import {
  approvedJobsInRange,
  binaryAsc,
  completedJobsInRange,
  createdJobsInRange,
  groupBy,
  kpisFor,
  loadActiveMetricJobs,
  loadClosedTransitionsInRange,
  loadEditorTransitions,
  loadOrgSettings,
  loadTransitionsByJob,
  mean,
  overdueEventsInRange,
  resolveRangeInput,
  revisionsRequestedInRange,
  stageAverages,
  toPercent,
  type ApprovedMetricJob,
  type MetricScope,
} from "./metrics";
import { computeEditorPerformance, computePhotographerPerformance } from "./performance";
import { computeWorkloads } from "./workloads";

const DAILY_MAX_DAYS = 31;

const avgTurnaround = (approved: readonly ApprovedMetricJob[], transitions: Map<string, TransitionLike[]>): number | null =>
  mean(approved.map((j) => turnaroundSeconds(j, transitions.get(j.id) ?? [])));

/* ------------------------------------------------------------------ */
/*  Trend                                                              */
/* ------------------------------------------------------------------ */

export interface TrendOptions {
  scope: MetricScope;
  /** Editor view: created/completed by jobs.editor_id, revisions by assignee, turnaround by approving editor. */
  editorId?: string;
  /** Photographer view: everything by jobs.photographer_id. */
  photographerId?: string;
}

/** Bucket boundaries (civil start dates + ISO instants) covering [range.from, range.to). */
export function trendBuckets(range: Range, timeZone: string): { date: string; from: string; to: string }[] {
  const fromCivil = civilDate(range.from, timeZone);
  const toCivil = civilDate(range.to, timeZone);
  if (!fromCivil || !toCivil) return [];
  const days = Math.max(1, civilDiffDays(fromCivil, toCivil));
  const step = days <= DAILY_MAX_DAYS ? 1 : 7;
  const out: { date: string; from: string; to: string }[] = [];
  for (let d = fromCivil; civilDiffDays(d, toCivil) > 0; d = addCivilDays(d, step)) {
    const next = addCivilDays(d, step);
    const end = civilDiffDays(next, toCivil) < 0 ? toCivil : next;
    out.push({ date: d, from: startOfCivilDayIso(d, timeZone), to: startOfCivilDayIso(end, timeZone) });
  }
  return out;
}

/** Volume trend over the range (created / completed / revisions / became overdue / turnaround). */
export async function buildTrend(db: DbLike, ctx: AuthContext, range: Range, opts: TrendOptions): Promise<TrendPoint[]> {
  const tz = ctx.settings.timezone;
  const jobFilter: SQL | undefined = opts.editorId
    ? eq(jobs.editorId, opts.editorId)
    : opts.photographerId
      ? eq(jobs.photographerId, opts.photographerId)
      : undefined;
  const q = { scope: opts.scope, where: jobFilter };
  const created = await createdJobsInRange(db, ctx, range, q);
  const completed = await completedJobsInRange(db, ctx, range, q);
  const revisions = (
    await revisionsRequestedInRange(db, ctx, range, {
      scope: opts.scope,
      where: opts.photographerId ? eq(jobs.photographerId, opts.photographerId) : undefined,
    })
  ).filter((r) => opts.editorId === undefined || r.assigneeUserId === opts.editorId);
  const overdue = await overdueEventsInRange(db, ctx, range, q);
  const approved = (
    await approvedJobsInRange(db, ctx, range, {
      scope: opts.scope,
      where: opts.photographerId ? eq(jobs.photographerId, opts.photographerId) : undefined,
    })
  ).filter((j) => opts.editorId === undefined || j.approvingEditorId === opts.editorId);
  const transitions = await loadTransitionsByJob(
    db,
    ctx,
    approved.map((j) => j.id),
  );

  const inBucket = (iso: string | null, b: { from: string; to: string }) => iso !== null && iso >= b.from && iso < b.to;
  return trendBuckets(range, tz).map((b) => {
    const approvedInBucket = approved.filter((j) => inBucket(j.approvedAt, b));
    return {
      date: b.date,
      created: created.filter((j) => inBucket(j.createdAt, b)).length,
      completed: completed.filter((j) => inBucket(j.completedAt, b)).length,
      revisionsRequested: revisions.filter((r) => inBucket(r.requestedAt, b)).length,
      becameOverdue: overdue.filter((e) => inBucket(e.createdAt, b)).length,
      avgTurnaroundSeconds: avgTurnaround(approvedInBucket, transitions),
      approved: approvedInBucket.length,
      onTimePercent: toPercent(onTimeRate(approvedInBucket).rate),
      revisionRate: revisionRate(approvedInBucket).rate,
    };
  });
}

/* ------------------------------------------------------------------ */
/*  Overview                                                           */
/* ------------------------------------------------------------------ */

/** `GET /api/analytics/overview?range=…` → AnalyticsOverview (analytics.view). */
export async function getAnalyticsOverview(db: DbLike, ctx: AuthContext, rawRange?: unknown): Promise<AnalyticsOverview> {
  assertCan(ctx, "analytics.view");
  const range = await resolveRangeInput(ctx, rawRange, undefined, { db });
  return computeAnalyticsOverview(db, ctx, range);
}

/** Overview without the permission check (reports reuse it). */
export async function computeAnalyticsOverview(db: DbLike, ctx: AuthContext, range: ResolvedRange): Promise<AnalyticsOverview> {
  const now = ctx.now();
  const settings = await loadOrgSettings(db, ctx);
  const scope = { scope: "org" as const };
  const kpis = await kpisFor(db, ctx, { scope: "org", now, weekStartsOn: settings.weekStartsOn });

  const created = await createdJobsInRange(db, ctx, range, scope);
  const completed = await completedJobsInRange(db, ctx, range, scope);
  const approved = await approvedJobsInRange(db, ctx, range, scope);
  const active = await loadActiveMetricJobs(db, ctx, scope);
  const transitions = await loadTransitionsByJob(
    db,
    ctx,
    approved.map((j) => j.id),
  );

  const createdLive = created.filter((j) => j.statusCategory !== "cancelled");
  const createdDone = createdLive.filter((j) => CATEGORY_GROUPS.DONE.includes(j.statusCategory)).length;

  const workloads = await computeWorkloads(db, ctx, { now });
  const activeEditors = workloads.rows.filter((r) => r.editor.isActive);

  // by job type
  const typeIds = new Set([...created, ...completed, ...approved].map((j) => j.jobTypeId));
  const typeRows = (
    await db
      .select({ id: jobTypes.id, name: jobTypes.name, colour: jobTypes.colour, archivedAt: jobTypes.archivedAt, sortOrder: jobTypes.sortOrder })
      .from(jobTypes)
      .where(eq(jobTypes.organisationId, ctx.organisationId))
      .orderBy(asc(jobTypes.sortOrder), binaryAsc(jobTypes.name), asc(jobTypes.id))
  ).filter((t) => t.archivedAt === null || typeIds.has(t.id));
  const createdByType = groupBy(created, (j) => j.jobTypeId);
  const completedByType = groupBy(completed, (j) => j.jobTypeId);
  const approvedByType = groupBy(approved, (j) => j.jobTypeId);

  // by client
  const createdByClient = groupBy(created, (j) => j.clientId);
  const completedByClient = groupBy(completed, (j) => j.clientId);
  const overdueByClient = groupBy(
    active.filter((j) => isDeadlineBound(j.statusCategory) && j.dueDate !== null && j.dueDate < now),
    (j) => j.clientId,
  );
  const clientIds = [...new Set([...createdByClient.keys(), ...completedByClient.keys(), ...overdueByClient.keys()])];
  const clientRows =
    clientIds.length === 0
      ? []
      : await db
          .select({ id: clients.id, name: clients.name })
          .from(clients)
          .where(and(eq(clients.organisationId, ctx.organisationId), inArray(clients.id, clientIds)))
          .orderBy(asc(clients.id));

  return {
    range,
    kpis,
    completed: completed.length,
    outstanding: kpis.active,
    overdue: kpis.overdue,
    avgTurnaroundSeconds: avgTurnaround(approved, transitions),
    onTimePercent: toPercent(onTimeRate(approved).rate),
    revisionRate: revisionRate(approved).rate,
    completionRate: createdLive.length === 0 ? null : createdDone / createdLive.length,
    capacityHours: activeEditors.reduce((s, r) => s + r.editor.capacityHoursPerWeek, 0),
    loadHours: activeEditors.reduce((s, r) => s + r.score, 0),
    trend: await buildTrend(db, ctx, range, { scope: "org" }),
    byJobType: typeRows.map((t) => ({
      jobType: { id: t.id, name: t.name, colour: t.colour },
      created: createdByType.get(t.id)?.length ?? 0,
      completed: completedByType.get(t.id)?.length ?? 0,
      avgTurnaroundSeconds: avgTurnaround(approvedByType.get(t.id) ?? [], transitions),
    })),
    byClient: clientRows
      .map((c) => ({
        client: { id: c.id, name: c.name },
        created: createdByClient.get(c.id)?.length ?? 0,
        completed: completedByClient.get(c.id)?.length ?? 0,
        overdue: overdueByClient.get(c.id)?.length ?? 0,
      }))
      .sort((a, b) => b.created - a.created || b.completed - a.completed || a.client.name.localeCompare(b.client.name)),
    editors: await computeEditorPerformance(db, ctx, range, { now }),
    photographers: await computePhotographerPerformance(db, ctx, range, { now }),
    stageAverages: stageAverages(await loadClosedTransitionsInRange(db, ctx, range)),
  };
}

/* ------------------------------------------------------------------ */
/*  Per editor / me                                                    */
/* ------------------------------------------------------------------ */

function zeroEditorRow(user: UserRef): PerformanceRow {
  return {
    user,
    completed: 0,
    approved: 0,
    avgTurnaroundSeconds: null,
    avgEditingSeconds: null,
    avgReviewSeconds: null,
    revisionRate: null,
    revisionsPerJob: null,
    onTimePercent: null,
    overdue: 0,
    active: 0,
    completedThisWeek: 0,
    completedThisMonth: 0,
  };
}

function zeroPhotographerRow(user: UserRef): PhotographerPerformanceRow {
  return { user, created: 0, submitted: 0, completed: 0, avgProcessingSeconds: null, avgEndToEndSeconds: null, avgReviewResponseSeconds: null, active: 0, overdue: 0 };
}

const refOf = (u: { id: string; name: string; role: UserRef["role"]; avatarColour: string; isActive: boolean }): UserRef => ({
  id: u.id,
  name: u.name,
  role: u.role,
  avatarColour: u.avatarColour,
  isActive: u.isActive,
});

/**
 * `GET /api/analytics/editors/:userId` — the editor themself
 * (analytics.view_self) or management (performance.view). 404 for foreign ids.
 */
export async function getEditorAnalytics(db: DbLike, ctx: AuthContext, userId: string, rawRange?: unknown): Promise<EditorAnalytics> {
  const target = await loadUserInOrg(db, ctx, userId);
  if (target.id === ctx.userId) assertCan(ctx, "analytics.view_self");
  else assertCan(ctx, "performance.view");
  const range = await resolveRangeInput(ctx, rawRange, undefined, { db });
  const user = refOf(target);
  return {
    range,
    editor: user,
    performance: (await computeEditorPerformance(db, ctx, range, { userIds: [target.id] }))[0] ?? zeroEditorRow(user),
    trend: await buildTrend(db, ctx, range, { scope: "org", editorId: target.id }),
    stageAverages: stageAverages(await loadEditorTransitions(db, ctx, target.id, { enteredFrom: range.from, enteredTo: range.to }), target.id),
  };
}

/** `GET /api/analytics/me` — My Performance for any role (analytics.view_self). */
export async function getMyAnalytics(db: DbLike, ctx: AuthContext, rawRange?: unknown): Promise<MyAnalytics> {
  assertCan(ctx, "analytics.view_self");
  const range = await resolveRangeInput(ctx, rawRange, undefined, { db });
  const me = ctx.userId ? await loadUserInOrg(db, ctx, ctx.userId) : null;
  if (!me) return { range, role: ctx.role, editor: null, photographer: null, trend: [], stageAverages: [] };
  const user = refOf(me);
  const editor = (await computeEditorPerformance(db, ctx, range, { userIds: [me.id] }))[0] ?? (me.role === "editor" ? zeroEditorRow(user) : null);
  const photographer =
    (await computePhotographerPerformance(db, ctx, range, { userIds: [me.id] }))[0] ?? (me.role === "photographer" ? zeroPhotographerRow(user) : null);
  const trend =
    me.role === "editor"
      ? await buildTrend(db, ctx, range, { scope: "org", editorId: me.id })
      : me.role === "photographer"
        ? await buildTrend(db, ctx, range, { scope: "org", photographerId: me.id })
        : await buildTrend(db, ctx, range, { scope: "visible" });
  return {
    range,
    role: me.role,
    editor,
    photographer,
    trend,
    stageAverages: editor ? stageAverages(await loadEditorTransitions(db, ctx, me.id, { enteredFrom: range.from, enteredTo: range.to }), me.id) : [],
  };
}

/** `GET /api/analytics/editors?range` — editor table (analytics.view). */
export async function getAnalyticsEditors(db: DbLike, ctx: AuthContext, rawRange?: unknown): Promise<{ range: ResolvedRange; editors: PerformanceRow[] }> {
  assertCan(ctx, "analytics.view");
  const range = await resolveRangeInput(ctx, rawRange, undefined, { db });
  return { range, editors: await computeEditorPerformance(db, ctx, range) };
}

/** `GET /api/analytics/photographers?range` — photographer table (analytics.view). */
export async function getAnalyticsPhotographers(
  db: DbLike,
  ctx: AuthContext,
  rawRange?: unknown,
): Promise<{ range: ResolvedRange; photographers: PhotographerPerformanceRow[] }> {
  assertCan(ctx, "analytics.view");
  const range = await resolveRangeInput(ctx, rawRange, undefined, { db });
  return { range, photographers: await computePhotographerPerformance(db, ctx, range) };
}
