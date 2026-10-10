/**
 * Bottleneck alerts (ARCHITECTURE.md §8 "Bottlenecks"). Aggregates the
 * inputs from the ledgers / state tables and delegates every rule to the
 * pure `evaluateBottlenecks()` in src/lib/metrics.ts. Counts are
 * organisation-wide (bottlenecks.view = O/M, photographers with
 * can_view_analytics), but the affected-job refs a viewer receives are
 * limited to jobs they may open (`visibleJobsWhere`); the rest are reported
 * as `hiddenJobCount` (`alertsForViewer`).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DbLike } from "@/db/index";
import { jobs as jobsTable, users } from "@/db/schema";
import { evaluateBottlenecks, type BottleneckInput } from "@/lib/metrics";
import type { AuthContext, BottleneckAlert } from "@/lib/types";
import { assertCan, isAdmin, visibleJobsWhere } from "@/server/auth/permissions";
import { bottleneckSettingsOf, loadActiveMetricJobs, revisionWeekWindows } from "./metrics";
import { bottleneckEditorsOf, computeWorkloads, type WorkloadComputation } from "./workloads";

/** Builds the pure-function input (exported for tests and the sweep). */
export async function bottleneckInput(db: DbLike, ctx: AuthContext, opts: { now?: string; workloads?: WorkloadComputation } = {}): Promise<BottleneckInput> {
  const now = opts.now ?? ctx.now();
  const workloads = opts.workloads ?? (await computeWorkloads(db, ctx, { now }));
  const jobs = (await loadActiveMetricJobs(db, ctx, { scope: "org" })).map((j) => ({
    id: j.id,
    jobNumber: j.jobNumber,
    name: j.name,
    statusCategory: j.statusCategory,
    statusEnteredAt: j.statusEnteredAt,
    dueDate: j.dueDate,
    reviewDueDate: j.reviewDueDate,
    isPaused: j.isPaused,
    lastActivityAt: j.lastActivityAt,
    editorId: j.editorId,
  }));
  const inactiveUserIds = (
    await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.organisationId, ctx.organisationId), eq(users.isActive, false)))
      .orderBy(asc(users.id))
  ).map((u) => u.id);
  return {
    now,
    settings: bottleneckSettingsOf(workloads.settings),
    jobs,
    editors: bottleneckEditorsOf(workloads),
    revisions: await revisionWeekWindows(db, ctx, now, 4),
    inactiveUserIds,
  };
}

/**
 * Alerts without a permission check and WITHOUT viewer scoping (every
 * affected job ref of the organisation) — for the seed summary / system
 * callers. Anything returned to a user goes through `alertsForViewer`.
 */
export async function computeBottlenecks(db: DbLike, ctx: AuthContext, opts: { now?: string; workloads?: WorkloadComputation } = {}): Promise<BottleneckAlert[]> {
  return evaluateBottlenecks(await bottleneckInput(db, ctx, opts));
}

/**
 * Limits each alert's job refs to jobs the viewer may open. Management and
 * system contexts see every job (unchanged, hiddenJobCount 0); other viewers
 * (photographers with the analytics flag) keep the org-wide `count` but only
 * receive refs that pass `visibleJobsWhere`, with the difference in
 * `hiddenJobCount`.
 */
export async function alertsForViewer(db: DbLike, ctx: AuthContext, alerts: readonly BottleneckAlert[]): Promise<BottleneckAlert[]> {
  if (isAdmin(ctx)) return alerts.map((a) => ({ ...a, hiddenJobCount: 0 }));
  const ids = [...new Set(alerts.flatMap((a) => a.jobs.map((j) => j.id)))];
  const visible = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    for (const r of await db.select({ id: jobsTable.id }).from(jobsTable).where(and(visibleJobsWhere(ctx), inArray(jobsTable.id, part)))) visible.add(r.id);
  }
  return alerts.map((a) => {
    const shown = a.jobs.filter((j) => visible.has(j.id));
    return { ...a, jobs: shown, hiddenJobCount: a.jobs.length - shown.length };
  });
}

/** Viewer-scoped alerts without the permission check (the dashboard gates on bottlenecks.view itself). */
export async function computeBottlenecksForViewer(
  db: DbLike,
  ctx: AuthContext,
  opts: { now?: string; workloads?: WorkloadComputation } = {},
): Promise<BottleneckAlert[]> {
  return alertsForViewer(db, ctx, await computeBottlenecks(db, ctx, opts));
}

/** `GET /api/bottlenecks` — every firing alert with the affected job refs the viewer may open, in BOTTLENECK_KINDS order. */
export async function getBottlenecks(db: DbLike, ctx: AuthContext): Promise<BottleneckAlert[]> {
  assertCan(ctx, "bottlenecks.view");
  return computeBottlenecksForViewer(db, ctx);
}
