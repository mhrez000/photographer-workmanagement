/**
 * Editor + photographer performance tables for a range (ARCHITECTURE.md §8,
 * §10 `/team/performance`). Shared by analytics, reports and the dashboard.
 *
 * Editors (attribution follows the ledgers, so reassignment is respected):
 *   - approved / turnaround / editing / review / revision rate / on-time:
 *     jobs approved in range whose APPROVING editor is E; editing seconds
 *     only count stage rows with editor_id_at_entry = E
 *   - completed: completedInRange with jobs.editor_id = E
 *   - active / overdue / completedThisWeek / completedThisMonth: now
 *     (identical to the WorkloadRow numbers)
 * Photographers (jobs.photographer_id = P):
 *   - created (created_at ∈ range), submitted (first_submitted_at ∈ range),
 *     completed (completedInRange), processing = firstSubmittedAt − start of
 *     the shoot's civil day (org tz, clamped ≥ 0) over submitted, end-to-end = completedAt − createdAt over completed,
 *     review response = Σ reviewer-held stage time over jobs approved in range
 */
import { and, asc, eq, gte, inArray, isNotNull, lt, or } from "drizzle-orm";
import type { DbLike } from "@/db/index";
import { jobs, users } from "@/db/schema";
import {
  editingSeconds,
  isPastDue,
  onTimeRate,
  photographerProcessingSeconds,
  reviewSeconds,
  revisionRate,
  turnaroundSeconds,
  type Range,
  type TransitionLike,
} from "@/lib/metrics";
import type { AuthContext, PerformanceReport, PerformanceRow, PhotographerPerformanceRow, ResolvedRange, UserRef } from "@/lib/types";
import { isDeadlineBound } from "@/lib/workflow";
import { assertCan } from "@/server/auth/permissions";
import {
  approvedJobsInRange,
  binaryAsc,
  completedJobsInRange,
  groupBy,
  loadActiveMetricJobs,
  loadMetricJobs,
  loadTransitionsByJob,
  mean,
  resolveRangeInput,
  toPercent,
  type ApprovedMetricJob,
  type MetricJob,
} from "./metrics";
import { computeWorkloads } from "./workloads";

export interface PerformanceOptions {
  /** Restrict to these users (rows are still computed from org-wide ledgers). */
  userIds?: readonly string[];
  now?: string;
}

async function usersByRole(
  db: DbLike,
  ctx: AuthContext,
  role: "editor" | "photographer",
  extraIds: readonly string[],
  restrict?: readonly string[],
): Promise<UserRef[]> {
  const extra = [...new Set(extraIds)];
  return db
    .select({ id: users.id, name: users.name, role: users.role, avatarColour: users.avatarColour, isActive: users.isActive })
    .from(users)
    .where(
      and(
        eq(users.organisationId, ctx.organisationId),
        extra.length > 0 ? or(and(eq(users.role, role), eq(users.isActive, true)), inArray(users.id, extra)) : and(eq(users.role, role), eq(users.isActive, true)),
        restrict ? inArray(users.id, [...restrict]) : undefined,
      ),
    )
    .orderBy(binaryAsc(users.name), asc(users.id));
}

/** Per-editor performance (no permission check). */
export async function computeEditorPerformance(db: DbLike, ctx: AuthContext, range: Range, opts: PerformanceOptions = {}): Promise<PerformanceRow[]> {
  const now = opts.now ?? ctx.now();
  const approved = await approvedJobsInRange(db, ctx, range, { scope: "org" });
  const completed = await completedJobsInRange(db, ctx, range, { scope: "org", where: isNotNull(jobs.editorId) });
  const workloads = await computeWorkloads(db, ctx, { now, editorIds: opts.userIds });
  const transitions = await loadTransitionsByJob(
    db,
    ctx,
    approved.map((j) => j.id),
  );
  const approvedBy = groupBy(approved, (j) => j.approvingEditorId);
  const completedBy = groupBy(completed, (j) => j.editorId);
  const workloadBy = new Map(workloads.rows.map((r) => [r.editor.id, r]));

  const people = await usersByRole(
    db,
    ctx,
    "editor",
    [...approvedBy.keys(), ...completedBy.keys(), ...workloadBy.keys()],
    opts.userIds,
  );
  return people.map((u) => editorRow(u, approvedBy.get(u.id) ?? [], completedBy.get(u.id)?.length ?? 0, transitions, now, workloadBy.get(u.id)));
}

function editorRow(
  user: UserRef,
  approved: readonly ApprovedMetricJob[],
  completed: number,
  transitions: Map<string, TransitionLike[]>,
  now: string,
  workload: { active: number; overdue: number; completedThisWeek: number; completedThisMonth: number } | undefined,
): PerformanceRow {
  const tOf = (id: string) => transitions.get(id) ?? [];
  const rr = revisionRate(approved);
  return {
    user,
    completed,
    approved: approved.length,
    avgTurnaroundSeconds: mean(approved.map((j) => turnaroundSeconds(j, tOf(j.id)))),
    avgEditingSeconds: mean(approved.map((j) => editingSeconds(tOf(j.id), now, user.id))),
    avgReviewSeconds: mean(approved.map((j) => reviewSeconds(tOf(j.id), now))),
    revisionRate: rr.rate,
    revisionsPerJob: rr.revisionsPerJob,
    onTimePercent: toPercent(onTimeRate(approved).rate),
    overdue: workload?.overdue ?? 0,
    active: workload?.active ?? 0,
    completedThisWeek: workload?.completedThisWeek ?? 0,
    completedThisMonth: workload?.completedThisMonth ?? 0,
  };
}

/** Per-photographer performance (no permission check). */
export async function computePhotographerPerformance(
  db: DbLike,
  ctx: AuthContext,
  range: Range,
  opts: PerformanceOptions = {},
): Promise<PhotographerPerformanceRow[]> {
  const now = opts.now ?? ctx.now();
  const tz = ctx.settings.timezone;
  const hasPhotographer = isNotNull(jobs.photographerId);
  const created = groupBy(
    await loadMetricJobs(db, ctx, { scope: "org", where: and(hasPhotographer, gte(jobs.createdAt, range.from), lt(jobs.createdAt, range.to)) }),
    (j) => j.photographerId,
  );
  const submitted = groupBy(
    await loadMetricJobs(db, ctx, { scope: "org", where: and(hasPhotographer, gte(jobs.firstSubmittedAt, range.from), lt(jobs.firstSubmittedAt, range.to)) }),
    (j) => j.photographerId,
  );
  const completed = groupBy(await completedJobsInRange(db, ctx, range, { scope: "org", where: hasPhotographer }), (j) => j.photographerId);
  const approvedList = await approvedJobsInRange(db, ctx, range, { scope: "org", where: hasPhotographer });
  const approved = groupBy(approvedList, (j) => j.photographerId);
  const active = groupBy(await loadActiveMetricJobs(db, ctx, { scope: "org", where: hasPhotographer }), (j) => j.photographerId);
  const transitions = await loadTransitionsByJob(
    db,
    ctx,
    approvedList.map((j) => j.id),
  );

  const people = await usersByRole(
    db,
    ctx,
    "photographer",
    [...created.keys(), ...submitted.keys(), ...completed.keys(), ...active.keys()],
    opts.userIds,
  );
  return people.map((user) => {
    const act: MetricJob[] = active.get(user.id) ?? [];
    return {
      user,
      created: created.get(user.id)?.length ?? 0,
      submitted: submitted.get(user.id)?.length ?? 0,
      completed: completed.get(user.id)?.length ?? 0,
      avgProcessingSeconds: mean((submitted.get(user.id) ?? []).map((j) => photographerProcessingSeconds(j, tz).processing)),
      avgEndToEndSeconds: mean((completed.get(user.id) ?? []).map((j) => photographerProcessingSeconds(j, tz).endToEnd)),
      avgReviewResponseSeconds: mean((approved.get(user.id) ?? []).map((j) => reviewSeconds(transitions.get(j.id) ?? [], now))),
      active: act.length,
      overdue: act.filter((j) => isDeadlineBound(j.statusCategory) && isPastDue(j.dueDate, now)).length,
    };
  });
}

/** `/team/performance` (performance.view = O/M). `rawRange` = query params or a ResolvedRange. */
export async function getPerformance(db: DbLike, ctx: AuthContext, rawRange?: unknown): Promise<PerformanceReport> {
  assertCan(ctx, "performance.view");
  const range: ResolvedRange = await resolveRangeInput(ctx, rawRange, undefined, { db });
  return {
    range,
    editors: await computeEditorPerformance(db, ctx, range),
    photographers: await computePhotographerPerformance(db, ctx, range),
  };
}
