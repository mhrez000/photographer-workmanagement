/**
 * Bottleneck alerts (ARCHITECTURE.md §8 "Bottlenecks"). Aggregates the
 * inputs from the ledgers / state tables and delegates every rule to the
 * pure `evaluateBottlenecks()` in src/lib/metrics.ts. Organisation-wide
 * (bottlenecks.view = O/M, photographers with can_view_analytics).
 */
import { and, eq } from "drizzle-orm";
import type { DbLike } from "@/db/index";
import { users } from "@/db/schema";
import { evaluateBottlenecks, type BottleneckInput } from "@/lib/metrics";
import type { AuthContext, BottleneckAlert } from "@/lib/types";
import { assertCan } from "@/server/auth/permissions";
import { bottleneckSettingsOf, loadActiveMetricJobs, revisionWeekWindows } from "./metrics";
import { bottleneckEditorsOf, computeWorkloads, type WorkloadComputation } from "./workloads";

/** Builds the pure-function input (exported for tests and the sweep). */
export function bottleneckInput(db: DbLike, ctx: AuthContext, opts: { now?: string; workloads?: WorkloadComputation } = {}): BottleneckInput {
  const now = opts.now ?? ctx.now();
  const workloads = opts.workloads ?? computeWorkloads(db, ctx, { now });
  const jobs = loadActiveMetricJobs(db, ctx, { scope: "org" }).map((j) => ({
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
  const inactiveUserIds = db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.organisationId, ctx.organisationId), eq(users.isActive, false)))
    .all()
    .map((u) => u.id);
  return {
    now,
    settings: bottleneckSettingsOf(workloads.settings),
    jobs,
    editors: bottleneckEditorsOf(workloads),
    revisions: revisionWeekWindows(db, ctx, now, 4),
    inactiveUserIds,
  };
}

/** Alerts without a permission check (dashboard / sweep callers gate themselves). */
export function computeBottlenecks(db: DbLike, ctx: AuthContext, opts: { now?: string; workloads?: WorkloadComputation } = {}): BottleneckAlert[] {
  return evaluateBottlenecks(bottleneckInput(db, ctx, opts));
}

/** `GET /api/bottlenecks` — every firing alert with its affected job refs, in BOTTLENECK_KINDS order. */
export function getBottlenecks(db: DbLike, ctx: AuthContext): BottleneckAlert[] {
  assertCan(ctx, "bottlenecks.view");
  return computeBottlenecks(db, ctx);
}
