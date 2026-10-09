/**
 * Dashboard (ARCHITECTURE.md §8 KPI cards, §10 `/dashboard`).
 *
 * Owners / managers get the management variant: org-wide KPIs, the workload
 * overview, bottleneck banners, editor leaderboard. Photographers and editors
 * get the personal variant: KPIs over the jobs they can see, their own
 * workload / performance and a queue preview; team workloads and bottlenecks
 * only when their flags allow (workloads.view_team / bottlenecks.view).
 *
 * "Completed this week" (KPI, workloads, reports) always comes from the
 * shared `completedInRange()` so a job completed, reopened and re-completed
 * counts once — in the week of its latest completion.
 */
import { and, asc, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import type { DbLike } from "@/db/index";
import { jobs } from "@/db/schema";
import { CATEGORY_GROUPS } from "@/lib/constants";
import { onTimeRate, revisionRate } from "@/lib/metrics";
import type { AuthContext, DashboardData, DashboardLayout, DashboardPersonal, JobRow, KpiSummary } from "@/lib/types";
import { can, isManagement } from "@/server/auth/permissions";
import { allowedWidgetTypes, defaultLayoutFor, getDashboardLayout } from "@/server/services/dashboards";
import { listActivity } from "./activity";
import { computeBottlenecksForViewer } from "./bottlenecks";
import { approvedJobsInRange, completedJobsInRange, kpisFor, lastDaysRange, loadOrgSettings, monthRangeAt, toPercent, type MetricScope } from "./metrics";
import { computeEditorPerformance, computePhotographerPerformance } from "./performance";
import { categoryIn, orgDayBounds, selectJobRows } from "./scope";
import { computeWorkloads } from "./workloads";

export const DASHBOARD_LIST_LIMIT = 20;
export const RECENT_COMPLETED_LIMIT = 10;
export const RECENT_ACTIVITY_LIMIT = 15;
export const QUEUE_PREVIEW_LIMIT = 8;

/* ------------------------------------------------------------------ */
/*  Layout                                                             */
/* ------------------------------------------------------------------ */

/**
 * The viewer's layout — the SAME one `/dashboard` renders and
 * `GET /api/dashboard/layout` returns (services/dashboards.ts: saved row or
 * the role default, filtered to the widgets this viewer may see). A context
 * without a user (system) gets the filtered role default.
 */
export function dashboardLayoutFor(db: DbLike, ctx: AuthContext): DashboardLayout {
  if (ctx.userId === null || ctx.isSystem) {
    const allowed = allowedWidgetTypes(ctx);
    return { widgets: defaultLayoutFor(ctx.role).widgets.filter((w) => allowed.has(w.type)) };
  }
  return getDashboardLayout(db, ctx).layout;
}

/* ------------------------------------------------------------------ */
/*  Lists                                                              */
/* ------------------------------------------------------------------ */

const bound = () => categoryIn(CATEGORY_GROUPS.DEADLINE_BOUND);

/** Visible DEADLINE_BOUND jobs due later today (not yet overdue). */
export function dueTodayJobs(db: DbLike, ctx: AuthContext, now: string, limit = DASHBOARD_LIST_LIMIT): JobRow[] {
  const b = orgDayBounds(ctx, now);
  return selectJobRows(db, ctx, {
    where: and(bound(), gte(jobs.dueDate, now), lte(jobs.dueDate, b.endOfToday)),
    orderBy: [asc(jobs.dueDate), asc(jobs.jobNumber)],
    limit,
  });
}

/** Visible DEADLINE_BOUND jobs past their editing deadline, most overdue first. */
export function overdueJobs(db: DbLike, ctx: AuthContext, now: string, limit = DASHBOARD_LIST_LIMIT): JobRow[] {
  return selectJobRows(db, ctx, {
    where: and(bound(), lt(jobs.dueDate, now)),
    orderBy: [asc(jobs.dueDate), asc(jobs.jobNumber)],
    limit,
  });
}

/** Visible jobs whose open stage is completed, latest completion first. */
export function recentCompletedJobs(db: DbLike, ctx: AuthContext, limit = RECENT_COMPLETED_LIMIT): JobRow[] {
  return selectJobRows(db, ctx, {
    where: eq(jobs.statusCategory, "completed"),
    orderBy: [desc(jobs.completedAt), desc(jobs.id)],
    limit,
  });
}

/** The actor's next jobs: editors = held jobs (WORKLOAD); photographers = own active jobs, reviewer-held first. */
export function queuePreview(db: DbLike, ctx: AuthContext, limit = QUEUE_PREVIEW_LIMIT): JobRow[] {
  if (ctx.userId === null) return [];
  if (ctx.role === "editor") {
    return selectJobRows(db, ctx, {
      where: and(eq(jobs.editorId, ctx.userId), categoryIn(CATEGORY_GROUPS.WORKLOAD)),
      orderBy: [sql`${jobs.dueDate} asc nulls last`, asc(jobs.jobNumber)],
      limit,
    });
  }
  const reviewFirst = sql`(case when ${categoryIn(CATEGORY_GROUPS.REVIEWER_HOLDS)} then 0 else 1 end)`;
  return selectJobRows(db, ctx, {
    where: and(sql`(${jobs.photographerId} = ${ctx.userId} or ${jobs.createdByUserId} = ${ctx.userId})`, categoryIn(CATEGORY_GROUPS.ACTIVE)),
    orderBy: [reviewFirst, sql`${jobs.dueDate} asc nulls last`, asc(jobs.jobNumber)],
    limit,
  });
}

/* ------------------------------------------------------------------ */
/*  getDashboard                                                       */
/* ------------------------------------------------------------------ */

/** KPI cards for the viewer: org-wide for management, visible jobs otherwise. */
export function getKpis(db: DbLike, ctx: AuthContext): KpiSummary {
  return kpisFor(db, ctx, { scope: isManagement(ctx) || ctx.isSystem ? "org" : "visible" });
}

/** `GET /api/dashboard` → DashboardData (every authenticated user; content scoped by role/flags). */
export function getDashboard(db: DbLike, ctx: AuthContext): DashboardData {
  const now = ctx.now();
  const management = isManagement(ctx);
  const scope: MetricScope = management ? "org" : "visible";
  const settings = loadOrgSettings(db, ctx);
  const kpis = kpisFor(db, ctx, { scope, now, weekStartsOn: settings.weekStartsOn });

  const workloadComputation = computeWorkloads(db, ctx, { now });
  const seeTeam = management || can(ctx, "workloads.view_team");
  const workloads = seeTeam ? workloadComputation.rows : null;
  const bottlenecks = can(ctx, "bottlenecks.view") ? computeBottlenecksForViewer(db, ctx, { now, workloads: workloadComputation }) : [];

  const month = monthRangeAt(ctx, now);
  const approvedMonth = approvedJobsInRange(db, ctx, month, { scope });
  const rates = {
    completedThisMonth: completedJobsInRange(db, ctx, month, { scope }).length,
    revisionRate: revisionRate(approvedMonth).rate,
    onTimePercent: toPercent(onTimeRate(approvedMonth).rate),
  };

  let personal: DashboardPersonal | null = null;
  if (!management && ctx.userId !== null) {
    const me = ctx.userId;
    const last30 = lastDaysRange(ctx, now, 30);
    personal = {
      myWorkload: workloadComputation.rows.find((r) => r.editor.id === me) ?? null,
      myPerformance: ctx.role === "editor" ? (computeEditorPerformance(db, ctx, last30, { userIds: [me], now })[0] ?? null) : null,
      myPhotographerPerformance: ctx.role === "photographer" ? (computePhotographerPerformance(db, ctx, last30, { userIds: [me], now })[0] ?? null) : null,
      queuePreview: queuePreview(db, ctx),
    };
  }

  return {
    variant: management ? "management" : "personal",
    kpis,
    workloads,
    bottlenecks,
    recentActivity: listActivity(db, ctx, { limit: RECENT_ACTIVITY_LIMIT }).items,
    dueToday: dueTodayJobs(db, ctx, now),
    overdue: overdueJobs(db, ctx, now),
    recentCompleted: recentCompletedJobs(db, ctx),
    rates,
    editorPerformance: can(ctx, "performance.view") ? computeEditorPerformance(db, ctx, month, { now }) : null,
    personal,
    layout: dashboardLayoutFor(db, ctx),
    asOf: now,
  };
}
