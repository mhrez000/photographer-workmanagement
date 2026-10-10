/**
 * Dashboard (ARCHITECTURE.md §8 KPI cards, §10 `/dashboard`; docs/ROLES.md §8, §9).
 *
 * One builder for every staff persona. What a viewer gets:
 *  - KPIs + every job list are scope-aware: the view scope (`?scope=` /
 *    `pwm_scope` cookie, resolved by `viewScopeFor`) narrows to "My shoots"
 *    for admins and ⚑all members; everyone else sees their visible jobs
 *    (editors: the jobs they hold for due / overdue / deadlines / revisions).
 *  - `variant` = "business" for an admin / ⚑all member in the Whole business
 *    scope, else "personal".
 *  - Team workloads, bottlenecks, rates, editor performance and turnaround are
 *    business widgets gated by their permission (workloads.view_team,
 *    bottlenecks.view, analytics.view, performance.view) and never scoped.
 *  - Review duties (§8): in "mine" scope an admin's `awaitingReview` and
 *    `questions` keep the jobs only an admin can review
 *    (`needsAdminReviewWhere`) and count the rest as `moreInBusiness`.
 * Clients get 403 (`app.access`).
 *
 * "Completed this week" (KPI, workloads, reports) always comes from the
 * shared `completedInRange()` so a job completed, reopened and re-completed
 * counts once — in the week of its latest completion.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { DbLike } from "@/db/index";
import { jobComments, jobStatusTransitions, jobs, users } from "@/db/schema";
import { CATEGORY_GROUPS, QUESTION_COMMENT_KINDS } from "@/lib/constants";
import { onTimeRate, revisionRate } from "@/lib/metrics";
import type {
  AuthContext,
  DashboardData,
  DashboardDeadline,
  DashboardLayout,
  DashboardPersonal,
  DashboardQuestion,
  DashboardScopedList,
  JobRow,
  KpiSummary,
  TurnaroundSummary,
} from "@/lib/types";
import { can, hasBusinessView, isAdmin, managedJobsWhere, personaOf } from "@/server/auth/permissions";
import { allowedWidgetTypes, defaultLayoutFor, getDashboardLayout } from "@/server/services/dashboards";
import { resolveMetricScope } from "@/server/view-scope";
import { listActivity } from "./activity";
import { computeBottlenecksForViewer } from "./bottlenecks";
import { median } from "./timeline";
import { approvedJobsInRange, completedJobsInRange, kpisFor, lastDaysRange, loadOrgSettings, loadUserRefs, monthRangeAt, toPercent } from "./metrics";
import { computeEditorPerformance, computePhotographerPerformance } from "./performance";
import {
  assertStaffRead,
  categoryIn,
  countJobs,
  needsAdminReviewWhere,
  orgDayBounds,
  selectJobRows,
  viewScopeFor,
  viewScopeWhere,
  visibleJobsWhere,
  type ViewScope,
  type ViewScopeOptions,
} from "./scope";
import { computeWorkloads } from "./workloads";

export const DASHBOARD_LIST_LIMIT = 20;
export const RECENT_COMPLETED_LIMIT = 10;
export const RECENT_COMPLETED_DAYS = 14;
export const RECENT_ACTIVITY_LIMIT = 15;
export const QUEUE_PREVIEW_LIMIT = 8;
export const UPCOMING_DEADLINE_DAYS = 7;
export const QUESTION_EXCERPT_LENGTH = 200;

const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ */
/*  Layout                                                             */
/* ------------------------------------------------------------------ */

/**
 * The viewer's layout — the SAME one `/dashboard` renders and
 * `GET /api/dashboard/layout` returns (services/dashboards.ts: saved row or
 * the default, filtered to the widgets this viewer may see). A context
 * without a user (system) gets the filtered default.
 */
export async function dashboardLayoutFor(db: DbLike, ctx: AuthContext): Promise<DashboardLayout> {
  if (ctx.userId === null || ctx.isSystem) {
    const allowed = allowedWidgetTypes(ctx);
    return { widgets: defaultLayoutFor(personaOf(ctx)).widgets.filter((w) => allowed.has(w.type)) };
  }
  return (await getDashboardLayout(db, ctx)).layout;
}

/* ------------------------------------------------------------------ */
/*  Scope helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Personal narrowing of a dashboard list: editors see the jobs they hold
 * (their visible set also has past / created jobs, which are history, not
 * work); "mine" scope adds My shoots. Everyone else: no extra predicate.
 */
function listScopeWhere(ctx: AuthContext, scope: ViewScope | null): SQL | undefined {
  if (!ctx.isSystem && ctx.role === "editor") return ctx.userId ? eq(jobs.editorId, ctx.userId) : sql`1 = 0`;
  return viewScopeWhere(ctx, scope);
}

/* ------------------------------------------------------------------ */
/*  Lists                                                              */
/* ------------------------------------------------------------------ */

const bound = () => categoryIn(CATEGORY_GROUPS.DEADLINE_BOUND);

/** Visible DEADLINE_BOUND jobs due later today (not yet overdue). */
export async function dueTodayJobs(db: DbLike, ctx: AuthContext, now: string, limit = DASHBOARD_LIST_LIMIT, scope: ViewScope | null = null): Promise<JobRow[]> {
  const b = orgDayBounds(ctx, now);
  return selectJobRows(db, ctx, {
    where: and(bound(), gte(jobs.dueDate, now), lte(jobs.dueDate, b.endOfToday), listScopeWhere(ctx, scope)),
    orderBy: [asc(jobs.dueDate), asc(jobs.jobNumber)],
    limit,
  });
}

/** Visible DEADLINE_BOUND jobs past their editing deadline, most overdue first. */
export async function overdueJobs(db: DbLike, ctx: AuthContext, now: string, limit = DASHBOARD_LIST_LIMIT, scope: ViewScope | null = null): Promise<JobRow[]> {
  return selectJobRows(db, ctx, {
    where: and(bound(), lt(jobs.dueDate, now), listScopeWhere(ctx, scope)),
    orderBy: [asc(jobs.dueDate), asc(jobs.jobNumber)],
    limit,
  });
}

/**
 * "Recently delivered & completed" (§9): visible jobs whose open stage is
 * delivered or completed within the last RECENT_COMPLETED_DAYS, latest first.
 * Editors: jobs they edited (their visible history).
 */
export async function recentCompletedJobs(
  db: DbLike,
  ctx: AuthContext,
  limit = RECENT_COMPLETED_LIMIT,
  scope: ViewScope | null = null,
  now: string = ctx.now(),
): Promise<JobRow[]> {
  const since = new Date(Date.parse(now) - RECENT_COMPLETED_DAYS * DAY_MS).toISOString();
  const doneAt = sql`coalesce(${jobs.completedAt}, ${jobs.deliveredAt})`;
  return selectJobRows(db, ctx, {
    where: and(inArray(jobs.statusCategory, ["delivered", "completed"]), sql`${doneAt} >= ${since}`, viewScopeWhere(ctx, scope)),
    // SQLite sorted NULLs last in DESC; Postgres sorts them first unless told otherwise.
    orderBy: [sql`${doneAt} desc nulls last`, desc(jobs.id)],
    limit,
  });
}

/** The actor's next jobs: editors = held jobs (WORKLOAD) + "created by me, not started"; photographers = own active jobs, reviewer-held first. */
export async function queuePreview(db: DbLike, ctx: AuthContext, limit = QUEUE_PREVIEW_LIMIT): Promise<JobRow[]> {
  if (ctx.userId === null) return [];
  if (ctx.role === "editor") {
    const createdNotStarted = and(eq(jobs.createdByUserId, ctx.userId), isNull(jobs.editorId), isNull(jobs.startedAt), categoryIn(CATEGORY_GROUPS.ACTIVE));
    return selectJobRows(db, ctx, {
      where: or(and(eq(jobs.editorId, ctx.userId), categoryIn(CATEGORY_GROUPS.WORKLOAD)), createdNotStarted),
      orderBy: [sql`${jobs.dueDate} asc nulls last`, asc(jobs.jobNumber)],
      limit,
    });
  }
  if (ctx.role !== "photographer") return [];
  const reviewFirst = sql`(case when ${categoryIn(CATEGORY_GROUPS.REVIEWER_HOLDS)} then 0 else 1 end)`;
  return selectJobRows(db, ctx, {
    where: and(managedJobsWhere(ctx), categoryIn(CATEGORY_GROUPS.ACTIVE)),
    orderBy: [reviewFirst, sql`${jobs.dueDate} asc nulls last`, asc(jobs.jobNumber)],
    limit,
  });
}

/** `my_shoots`: active jobs where I am the photographer, by next step (reviews first, then due date). Editors → []. */
export async function myShootsJobs(db: DbLike, ctx: AuthContext, limit = DASHBOARD_LIST_LIMIT): Promise<JobRow[]> {
  if (ctx.isSystem || ctx.role !== "photographer" || ctx.userId === null) return [];
  const reviewFirst = sql`(case when ${categoryIn(CATEGORY_GROUPS.REVIEWER_HOLDS)} then 0 else 1 end)`;
  return selectJobRows(db, ctx, {
    where: and(eq(jobs.photographerId, ctx.userId), categoryIn(CATEGORY_GROUPS.ACTIVE)),
    orderBy: [reviewFirst, sql`${jobs.dueDate} asc nulls last`, asc(jobs.jobNumber)],
    limit,
  });
}

/**
 * `awaiting_review`: REVIEWER_HOLDS jobs the viewer may review, oldest first.
 * Admins: any job (in "mine" scope: my shoots ∪ jobs only an admin can review,
 * the rest counted as `moreInBusiness`); members with ⚑review: jobs they
 * manage; anyone else → null. Jobs the viewer edited are left out (self-review).
 */
export async function awaitingReviewList(
  db: DbLike,
  ctx: AuthContext,
  scope: ViewScope | null,
  limit = DASHBOARD_LIST_LIMIT,
): Promise<DashboardScopedList<JobRow> | null> {
  // Reviewers: admins (any job), members with Review submissions (jobs they manage).
  if (!isAdmin(ctx) && !(ctx.role === "photographer" && ctx.canReviewSubmissions)) return null;
  const me = ctx.userId ?? "";
  const notMine = sql`not exists (select 1 from job_assignments sr where sr.job_id = ${jobs.id} and sr.role = 'editor' and sr.user_id = ${me})`;
  const base = and(categoryIn(CATEGORY_GROUPS.REVIEWER_HOLDS), isAdmin(ctx) ? undefined : managedJobsWhere(ctx), notMine) as SQL;
  const narrowed = scopeWithReviewDuties(ctx, scope, base);
  const items = await selectJobRows(db, ctx, { where: narrowed, orderBy: [asc(jobs.statusEnteredAt), asc(jobs.jobNumber)], limit });
  const total = await countJobs(db, ctx, narrowed);
  const moreInBusiness = scope === "mine" ? Math.max(0, (await countJobs(db, ctx, base)) - total) : 0;
  return { items, total, moreInBusiness };
}

/** `base` narrowed for "mine": my shoots, plus (admins) jobs only an admin can review (§8). */
function scopeWithReviewDuties(ctx: AuthContext, scope: ViewScope | null, base: SQL): SQL {
  const mine = viewScopeWhere(ctx, scope);
  if (!mine) return base;
  return and(base, isAdmin(ctx) ? or(mine, needsAdminReviewWhere()) : mine) as SQL;
}

/**
 * `upcoming_deadlines`: due / review-due / delivery-due dates in the next
 * UPCOMING_DEADLINE_DAYS days on active visible jobs (editors: jobs they hold),
 * soonest first.
 */
export async function upcomingDeadlines(db: DbLike, ctx: AuthContext, now: string, scope: ViewScope | null, limit = DASHBOARD_LIST_LIMIT): Promise<DashboardDeadline[]> {
  const until = new Date(Date.parse(now) + UPCOMING_DEADLINE_DAYS * DAY_MS).toISOString();
  const within = (col: typeof jobs.dueDate | typeof jobs.reviewDueDate | typeof jobs.deliveryDueDate) => and(gt(col, now), lte(col, until));
  const rows = await selectJobRows(db, ctx, {
    where: and(
      categoryIn(CATEGORY_GROUPS.ACTIVE),
      or(and(bound(), within(jobs.dueDate)), and(categoryIn(CATEGORY_GROUPS.REVIEWER_HOLDS), within(jobs.reviewDueDate)), within(jobs.deliveryDueDate)),
      listScopeWhere(ctx, scope),
    ),
    orderBy: [sql`least(${jobs.dueDate}, ${jobs.reviewDueDate}, ${jobs.deliveryDueDate}) asc nulls last`, asc(jobs.jobNumber)],
    limit,
  });
  const inWindow = (at: string | null): at is string => at !== null && at > now && at <= until;
  const out: DashboardDeadline[] = [];
  for (const job of rows) {
    if (CATEGORY_GROUPS.DEADLINE_BOUND.includes(job.statusCategory) && inWindow(job.dueDate)) out.push({ job, kind: "due", at: job.dueDate });
    if (CATEGORY_GROUPS.REVIEWER_HOLDS.includes(job.statusCategory) && inWindow(job.reviewDueDate)) out.push({ job, kind: "review_due", at: job.reviewDueDate });
    if (inWindow(job.deliveryDueDate)) out.push({ job, kind: "delivery_due", at: job.deliveryDueDate });
  }
  out.sort((a, b) => a.at.localeCompare(b.at) || a.job.jobNumber.localeCompare(b.job.jobNumber));
  return out.slice(0, limit);
}

/** `revisions`: open revisions and resubmissions (editors: revisions to address on jobs they hold). */
export async function revisionJobs(db: DbLike, ctx: AuthContext, scope: ViewScope | null, limit = DASHBOARD_LIST_LIMIT): Promise<JobRow[]> {
  const categories = !ctx.isSystem && ctx.role === "editor" ? (["revision"] as const) : (["revision", "resubmitted"] as const);
  return selectJobRows(db, ctx, {
    where: and(categoryIn(categories), listScopeWhere(ctx, scope)),
    orderBy: [sql`${jobs.dueDate} asc nulls last`, asc(jobs.statusEnteredAt), asc(jobs.jobNumber)],
    limit,
  });
}

/* ------------------------------------------------------------------ */
/*  Questions (editor questions + waiting client feedback)             */
/* ------------------------------------------------------------------ */

const excerpt = (body: string): string => (body.length > QUESTION_EXCERPT_LENGTH ? `${body.slice(0, QUESTION_EXCERPT_LENGTH - 1)}…` : body);

/**
 * `questions` (§6.4 / §7.5): open editor questions (no reply from a staff
 * user other than the asker) and waiting client-feedback threads (latest
 * message from a client) on active or delivered jobs the viewer steers:
 * admins any job (mine scope: my shoots ∪ jobs only an admin can review);
 * members the jobs they manage; editors / clients → null.
 */
export async function openQuestions(db: DbLike, ctx: AuthContext, scope: ViewScope | null, limit = DASHBOARD_LIST_LIMIT): Promise<DashboardScopedList<DashboardQuestion> | null> {
  if (ctx.isSystem || ctx.role !== "photographer") return null;
  const steer = isAdmin(ctx) ? undefined : managedJobsWhere(ctx);
  const base = and(sql`${jobs.statusCategory} <> 'cancelled'`, steer) as SQL;
  const all = await waitingThreads(db, ctx, base);
  const mineWhere = viewScopeWhere(ctx, scope);
  const scoped = mineWhere ? await waitingThreads(db, ctx, and(base, isAdmin(ctx) ? or(mineWhere, needsAdminReviewWhere()) : mineWhere) as SQL) : all;
  return { items: scoped.slice(0, limit), total: scoped.length, moreInBusiness: mineWhere ? Math.max(0, all.length - scoped.length) : 0 };
}

async function waitingThreads(db: DbLike, ctx: AuthContext, jobWhere: SQL): Promise<DashboardQuestion[]> {
  const roots = await db
    .select({ comment: jobComments, job: { id: jobs.id, jobNumber: jobs.jobNumber, name: jobs.name } })
    .from(jobComments)
    .innerJoin(jobs, eq(jobs.id, jobComments.jobId))
    .where(
      and(
        eq(jobComments.organisationId, ctx.organisationId),
        isNull(jobComments.parentCommentId),
        isNull(jobComments.deletedAt),
        inArray(jobComments.kind, [...QUESTION_COMMENT_KINDS, "client_feedback"]),
        visibleJobsWhere(ctx),
        jobWhere,
      ),
    )
    .orderBy(asc(jobComments.createdAt), asc(jobComments.id));
  if (roots.length === 0) return [];
  const rootIds = roots.map((r) => r.comment.id);
  const replies = await db
    .select({ rootCommentId: jobComments.rootCommentId, authorUserId: jobComments.authorUserId, body: jobComments.body, createdAt: jobComments.createdAt })
    .from(jobComments)
    .where(and(eq(jobComments.organisationId, ctx.organisationId), inArray(jobComments.rootCommentId, rootIds), isNull(jobComments.deletedAt), sql`${jobComments.parentCommentId} is not null`))
    .orderBy(asc(jobComments.createdAt), asc(jobComments.id));
  const authorIds = [...new Set([...roots.map((r) => r.comment.authorUserId), ...replies.map((r) => r.authorUserId)])];
  const roles = new Map(
    (await db.select({ id: users.id, role: users.role }).from(users).where(and(eq(users.organisationId, ctx.organisationId), inArray(users.id, authorIds)))).map(
      (u) => [u.id, u.role] as const,
    ),
  );
  const refs = await loadUserRefs(db, ctx, authorIds);
  const out: DashboardQuestion[] = [];
  for (const { comment, job } of roots) {
    const thread = replies.filter((r) => r.rootCommentId === comment.id);
    const author = refs.get(comment.authorUserId);
    if (!author) continue;
    if (comment.kind === "client_feedback") {
      const last = thread.at(-1) ?? { authorUserId: comment.authorUserId, body: comment.body, createdAt: comment.createdAt };
      if (roles.get(last.authorUserId) !== "client") continue;
      out.push({ commentId: comment.id, kind: "client_feedback", job, author, excerpt: excerpt(last.body), waitingSince: last.createdAt });
    } else {
      const answered = thread.some((r) => r.authorUserId !== comment.authorUserId && roles.get(r.authorUserId) !== "client");
      if (answered) continue;
      const last = thread.at(-1) ?? { body: comment.body, createdAt: comment.createdAt };
      out.push({ commentId: comment.id, kind: "question", job, author, excerpt: excerpt(last.body), waitingSince: last.createdAt });
    }
  }
  out.sort((a, b) => a.waitingSince.localeCompare(b.waitingSince) || a.commentId.localeCompare(b.commentId));
  return out;
}

/* ------------------------------------------------------------------ */
/*  Turnaround (analytics)                                             */
/* ------------------------------------------------------------------ */

/**
 * `turnaround`: median shoot → delivered (delivered_at, else completed_at)
 * and submitted → reviewed (submission to the next approval / revision
 * request), last 30 days vs the 30 before. Organisation-wide; analytics.view only.
 */
export async function computeTurnaround(db: DbLike, ctx: AuthContext, now: string): Promise<TurnaroundSummary> {
  const t = Date.parse(now);
  const currentFrom = new Date(t - 30 * DAY_MS).toISOString();
  const previousFrom = new Date(t - 60 * DAY_MS).toISOString();
  const doneAt = sql<string>`coalesce(${jobs.deliveredAt}, ${jobs.completedAt})`;
  const delivered = await db
    .select({ shootDate: jobs.shootDate, doneAt })
    .from(jobs)
    .where(and(eq(jobs.organisationId, ctx.organisationId), sql`${jobs.shootDate} is not null`, sql`${doneAt} >= ${previousFrom}`, sql`${doneAt} < ${now}`));
  const shootSecs = (from: string, to: string) =>
    delivered
      .filter((r) => r.doneAt >= from && r.doneAt < to && r.shootDate !== null)
      .map((r) => (Date.parse(r.doneAt) - Date.parse(r.shootDate as string)) / 1000)
      .filter((v) => Number.isFinite(v) && v >= 0);

  const transitions = await db
    .select({ jobId: jobStatusTransitions.jobId, toCategory: jobStatusTransitions.toCategory, enteredAt: jobStatusTransitions.enteredAt, sequence: jobStatusTransitions.sequence })
    .from(jobStatusTransitions)
    .where(
      and(
        eq(jobStatusTransitions.organisationId, ctx.organisationId),
        inArray(jobStatusTransitions.toCategory, ["submitted", "resubmitted", "approved", "revision"]),
        gte(jobStatusTransitions.enteredAt, new Date(t - 120 * DAY_MS).toISOString()),
      ),
    )
    .orderBy(asc(jobStatusTransitions.jobId), asc(jobStatusTransitions.sequence));
  const reviews: { at: string; seconds: number }[] = [];
  let lastSubmit: { jobId: string; at: string } | null = null;
  for (const tr of transitions) {
    if (tr.toCategory === "submitted" || tr.toCategory === "resubmitted") {
      lastSubmit = { jobId: tr.jobId, at: tr.enteredAt };
    } else if (lastSubmit && lastSubmit.jobId === tr.jobId) {
      reviews.push({ at: tr.enteredAt, seconds: (Date.parse(tr.enteredAt) - Date.parse(lastSubmit.at)) / 1000 });
      lastSubmit = null;
    }
  }
  const reviewSecs = (from: string, to: string) => reviews.filter((r) => r.at >= from && r.at < to && r.seconds >= 0).map((r) => r.seconds);
  const med = (values: number[]) => (values.length === 0 ? null : median(values));
  const curShoot = shootSecs(currentFrom, now);
  const curReview = reviewSecs(currentFrom, now);
  return {
    shootToDelivered: { current: med(curShoot), previous: med(shootSecs(previousFrom, currentFrom)), count: curShoot.length },
    submittedToReviewed: { current: med(curReview), previous: med(reviewSecs(previousFrom, currentFrom)), count: curReview.length },
  };
}

/* ------------------------------------------------------------------ */
/*  getDashboard                                                       */
/* ------------------------------------------------------------------ */

/**
 * KPI metric scope (§8 `resolveMetricScope`, §9): admins / ⚑all members in the
 * Whole business scope → every job; "mine" → my shoots; everyone else → their
 * visible jobs, and for editors the jobs they hold ("kpis ✓ (assigned)").
 */
function kpiScope(ctx: AuthContext, scope: ViewScope | null): { scope: "org" | "visible"; where?: SQL } {
  if (ctx.isSystem) return { scope: "org" };
  const metric = resolveMetricScope(ctx, scope);
  return { scope: metric.metric, where: and(metric.extra, ctx.role === "editor" ? listScopeWhere(ctx, scope) : undefined) };
}

/** KPI cards for the viewer under the resolved view scope. */
export async function getKpis(db: DbLike, ctx: AuthContext, opts: ViewScopeOptions = {}): Promise<KpiSummary> {
  assertStaffRead(ctx);
  return kpisFor(db, ctx, kpiScope(ctx, viewScopeFor(ctx, opts)));
}

/**
 * `GET /api/dashboard` → DashboardData (every staff persona; content scoped by
 * persona, switches and the view scope: `opts.scope` = `?scope=`,
 * `opts.scopeCookie` = the `pwm_scope` cookie).
 */
export async function getDashboard(db: DbLike, ctx: AuthContext, opts: ViewScopeOptions = {}): Promise<DashboardData> {
  assertStaffRead(ctx);
  const now = ctx.now();
  const scope = viewScopeFor(ctx, opts);
  const business = scope === "business" && hasBusinessView(ctx);
  const settings = await loadOrgSettings(db, ctx);
  const kpis = await kpisFor(db, ctx, { ...kpiScope(ctx, scope), now, weekStartsOn: settings.weekStartsOn });

  const workloadComputation = await computeWorkloads(db, ctx, { now });
  const workloads = can(ctx, "workloads.view_team") ? workloadComputation.rows : null;
  const bottlenecks = can(ctx, "bottlenecks.view") ? await computeBottlenecksForViewer(db, ctx, { now, workloads: workloadComputation }) : [];

  // Rates are a business widget (analytics) for analytics viewers, else over the viewer's visible jobs.
  const rateScope = can(ctx, "analytics.view") ? "org" : "visible";
  const month = monthRangeAt(ctx, now);
  const approvedMonth = await approvedJobsInRange(db, ctx, month, { scope: rateScope });
  const rates = {
    completedThisMonth: (await completedJobsInRange(db, ctx, month, { scope: rateScope })).length,
    revisionRate: revisionRate(approvedMonth).rate,
    onTimePercent: toPercent(onTimeRate(approvedMonth).rate),
  };

  let personal: DashboardPersonal | null = null;
  if (ctx.userId !== null && !business) {
    const me = ctx.userId;
    const last30 = lastDaysRange(ctx, now, 30);
    personal = {
      myWorkload: workloadComputation.rows.find((r) => r.editor.id === me) ?? null,
      myPerformance: ctx.role === "editor" ? ((await computeEditorPerformance(db, ctx, last30, { userIds: [me], now }))[0] ?? null) : null,
      myPhotographerPerformance:
        ctx.role === "photographer" ? ((await computePhotographerPerformance(db, ctx, last30, { userIds: [me], now }))[0] ?? null) : null,
      queuePreview: await queuePreview(db, ctx),
    };
  }

  const recentActivity = (await listActivity(db, ctx, { limit: RECENT_ACTIVITY_LIMIT, ...(scope ? { scope } : {}) })).items;
  const dueToday = await dueTodayJobs(db, ctx, now, DASHBOARD_LIST_LIMIT, scope);
  const overdue = await overdueJobs(db, ctx, now, DASHBOARD_LIST_LIMIT, scope);
  const recentCompleted = await recentCompletedJobs(db, ctx, RECENT_COMPLETED_LIMIT, scope, now);
  const editorPerformance = can(ctx, "performance.view") ? await computeEditorPerformance(db, ctx, month, { now }) : null;
  const layout = await dashboardLayoutFor(db, ctx);

  return {
    variant: business ? "business" : "personal",
    scope,
    kpis,
    workloads,
    bottlenecks,
    recentActivity,
    dueToday,
    overdue,
    recentCompleted,
    rates,
    editorPerformance,
    personal,
    myShoots: await myShootsJobs(db, ctx),
    awaitingReview: await awaitingReviewList(db, ctx, scope),
    questions: await openQuestions(db, ctx, scope),
    upcomingDeadlines: await upcomingDeadlines(db, ctx, now, scope),
    revisions: await revisionJobs(db, ctx, scope),
    turnaround: can(ctx, "analytics.view") ? await computeTurnaround(db, ctx, now) : null,
    layout,
    asOf: now,
  };
}
