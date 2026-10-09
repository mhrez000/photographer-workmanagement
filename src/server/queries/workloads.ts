/**
 * Editor workloads (ARCHITECTURE.md §8 "Workload score / band / historical
 * workload", §10 `/team/workloads`, `/team/users/[id]`).
 *
 * Rows cover every active editor plus any user (normally a deactivated
 * editor) who still holds ACTIVE jobs; the latter are flagged with
 * `band = overloaded, bandReason = inactive` by `workloadBand()`.
 *
 * Definitions (shared with bottlenecks / performance / directories):
 *   - held jobs = jobs with editor_id = E in CATEGORY_GROUPS.WORKLOAD
 *     (editor-held + reviewer-held); `active` = their count
 *   - overdue / dueToday / dueWithin48h / paused are over held jobs;
 *     dueWithin48h excludes jobs already overdue
 *   - completedThisWeek/Month: completedInRange over jobs whose editor_id = E
 *   - revisionRate: last 30 days, jobs credited to E as approving editor
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { DbLike } from "@/db/index";
import { jobAssignments, jobs, users } from "@/db/schema";
import { CATEGORY_GROUPS, WORKLOAD_THRESHOLDS } from "@/lib/constants";
import { addCivilDays, civilDate, civilDiffDays, startOfCivilDayIso, todayCivil } from "@/lib/dates";
import {
  avgSecondsPerCategory,
  editingSeconds,
  historicalWorkloadSeries,
  isDueTodayAt,
  isDueWithinHours,
  isPastDue,
  onTimeRate,
  reviewSeconds,
  revisionRate,
  turnaroundSeconds,
  workloadBand,
  workloadScore,
  type AssignmentLike,
  type BottleneckEditor,
} from "@/lib/metrics";
import type { AuthContext, CompletedWorkItem, OrganisationSettings, User, UserCompletedWork, UserRef, WorkloadDetail, WorkloadRow } from "@/lib/types";
import { isWorkloadCategory } from "@/lib/workflow";
import { assertCan, can, isManagement } from "@/server/auth/permissions";
import { loadUserInOrg } from "@/server/services/_shared";
import {
  approvedJobsInRange,
  completedJobsInRange,
  groupBy,
  lastDaysRange,
  loadEditorTransitions,
  loadJobTypeDefaultHours,
  loadMetricJobs,
  loadOrgSettings,
  loadTransitionsByJob,
  mean,
  monthRangeAt,
  resolveRangeInput,
  toPercent,
  weekRangeAt,
  workloadSettingsOf,
  type MetricJob,
} from "./metrics";
import { categoryIn, mapJobRows, selectJobRows, selectRawJobs } from "./scope";

const BAND_ORDER = { overloaded: 0, near_capacity: 1, healthy: 2 } as const;

export interface WorkloadComputation {
  rows: WorkloadRow[];
  /** Held (WORKLOAD-category) jobs per editor id. */
  held: Map<string, MetricJob[]>;
  /** Held jobs due within organisation_settings.editing_bottleneck_due_within_hours (not overdue), per editor. */
  dueSoonForBottleneck: Map<string, number>;
  settings: OrganisationSettings;
  now: string;
}

type EditorUser = Pick<User, "id" | "name" | "role" | "avatarColour" | "isActive" | "capacityHoursPerWeek">;

const userRefOf = (u: Pick<User, "id" | "name" | "role" | "avatarColour" | "isActive">): UserRef => ({
  id: u.id,
  name: u.name,
  role: u.role,
  avatarColour: u.avatarColour,
  isActive: u.isActive,
});

/**
 * Organisation-wide workload computation (no permission check — callers
 * gate). `editorIds` restricts the output rows (the underlying counts are
 * identical either way).
 */
export function computeWorkloads(db: DbLike, ctx: AuthContext, opts: { now?: string; editorIds?: readonly string[] } = {}): WorkloadComputation {
  const now = opts.now ?? ctx.now();
  const settings = loadOrgSettings(db, ctx);
  const ws = workloadSettingsOf(settings);
  const jobTypeDefaults = loadJobTypeDefaultHours(db, ctx);

  const restrict = opts.editorIds ? [...new Set(opts.editorIds)] : null;
  if (restrict && restrict.length === 0) return { rows: [], held: new Map(), dueSoonForBottleneck: new Map(), settings, now };

  const activeWithEditor = loadMetricJobs(db, ctx, {
    scope: "org",
    where: and(isNotNull(jobs.editorId), categoryIn(CATEGORY_GROUPS.ACTIVE), restrict ? inArray(jobs.editorId, restrict) : undefined),
  });
  const holders = new Set(activeWithEditor.map((j) => j.editorId).filter((v): v is string => v !== null));

  const candidates: EditorUser[] = db
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      avatarColour: users.avatarColour,
      isActive: users.isActive,
      capacityHoursPerWeek: users.capacityHoursPerWeek,
    })
    .from(users)
    .where(
      and(
        eq(users.organisationId, ctx.organisationId),
        holders.size > 0 ? or(eq(users.role, "editor"), inArray(users.id, [...holders])) : eq(users.role, "editor"),
        restrict ? inArray(users.id, restrict) : undefined,
      ),
    )
    .orderBy(asc(users.name))
    .all()
    .filter((u) => u.isActive || holders.has(u.id));

  const month = monthRangeAt(ctx, now);
  const week = weekRangeAt(ctx, now, settings.weekStartsOn);
  const editorFilter = restrict ? inArray(jobs.editorId, restrict) : isNotNull(jobs.editorId);
  const completedMonth = groupBy(completedJobsInRange(db, ctx, month, { scope: "org", where: editorFilter }), (j) => j.editorId);
  const completedWeek = groupBy(completedJobsInRange(db, ctx, week, { scope: "org", where: editorFilter }), (j) => j.editorId);
  const approved = groupBy(approvedJobsInRange(db, ctx, lastDaysRange(ctx, now, 30), { scope: "org" }), (j) => j.approvingEditorId);

  const byEditor = groupBy(activeWithEditor, (j) => j.editorId);
  const held = new Map<string, MetricJob[]>();
  const dueSoonForBottleneck = new Map<string, number>();
  const rows: WorkloadRow[] = [];

  for (const u of candidates) {
    const mine = (byEditor.get(u.id) ?? []).filter((j) => isWorkloadCategory(j.statusCategory));
    held.set(u.id, mine);
    const count = (pred: (j: MetricJob) => boolean) => mine.filter(pred).length;
    const overdue = count((j) => isPastDue(j.dueDate, now));
    const score = workloadScore(mine, { settings: ws, jobTypeDefaults, now, tz: ctx.settings.timezone });
    const band = workloadBand(score, { capacityHours: u.capacityHoursPerWeek, settings: ws, activeCount: mine.length, overdueCount: overdue, isActive: u.isActive });
    dueSoonForBottleneck.set(
      u.id,
      count((j) => !isPastDue(j.dueDate, now) && isDueWithinHours(j.dueDate, now, settings.editingBottleneckDueWithinHours)),
    );
    rows.push({
      editor: { ...userRefOf(u), capacityHoursPerWeek: u.capacityHoursPerWeek ?? settings.defaultCapacityHoursPerWeek },
      assigned: count((j) => j.statusCategory === "assigned"),
      accepted: count((j) => j.statusCategory === "accepted"),
      inProgress: count((j) => j.statusCategory === "in_progress"),
      revision: count((j) => j.statusCategory === "revision"),
      awaitingReview: count((j) => CATEGORY_GROUPS.REVIEWER_HOLDS.includes(j.statusCategory)),
      active: mine.length,
      dueToday: count((j) => isDueTodayAt(j.dueDate, now, ctx.settings.timezone)),
      dueWithin48h: count((j) => !isPastDue(j.dueDate, now) && isDueWithinHours(j.dueDate, now, WORKLOAD_THRESHOLDS.dueSoonHours)),
      overdue,
      paused: count((j) => j.isPaused),
      completedThisWeek: completedWeek.get(u.id)?.length ?? 0,
      completedThisMonth: completedMonth.get(u.id)?.length ?? 0,
      revisionRate: revisionRate(approved.get(u.id) ?? []).rate,
      score,
      ratio: band.ratio,
      band: band.band,
      bandReason: band.reason,
    });
  }

  rows.sort((a, b) => BAND_ORDER[a.band] - BAND_ORDER[b.band] || b.ratio - a.ratio || a.editor.name.localeCompare(b.editor.name));
  return { rows, held, dueSoonForBottleneck, settings, now };
}

/** Bottleneck inputs derived from a workload computation. */
export function bottleneckEditorsOf(c: WorkloadComputation): BottleneckEditor[] {
  return c.rows.map((r) => ({
    user: { id: r.editor.id, name: r.editor.name, role: r.editor.role, avatarColour: r.editor.avatarColour, isActive: r.editor.isActive },
    band: r.band,
    active: r.active,
    dueSoon: c.dueSoonForBottleneck.get(r.editor.id) ?? 0,
  }));
}

/**
 * `GET /api/workloads`. With `workloads.view_team` (O/M; photographers with
 * can_view_team_workloads; editors when editors_see_team_workloads) every
 * editor's aggregate row; otherwise only the viewer's own row (editors) or
 * nothing (photographers). Aggregates only — never job rows.
 */
export function getWorkloads(db: DbLike, ctx: AuthContext): WorkloadRow[] {
  if (can(ctx, "workloads.view_team")) return computeWorkloads(db, ctx).rows;
  assertCan(ctx, "workloads.view_self");
  if (ctx.userId === null) return [];
  return computeWorkloads(db, ctx, { editorIds: [ctx.userId] }).rows;
}

/** The viewer's own workload row (null when they hold nothing and are not an editor). */
export function getMyWorkload(db: DbLike, ctx: AuthContext): WorkloadRow | null {
  assertCan(ctx, "workloads.view_self");
  if (ctx.userId === null) return null;
  return computeWorkloads(db, ctx, { editorIds: [ctx.userId] }).rows[0] ?? null;
}

function emptyRow(u: User, settings: OrganisationSettings): WorkloadRow {
  const band = workloadBand(0, { capacityHours: u.capacityHoursPerWeek, settings: workloadSettingsOf(settings), activeCount: 0, overdueCount: 0, isActive: u.isActive });
  return {
    editor: { ...userRefOf(u), capacityHoursPerWeek: u.capacityHoursPerWeek ?? settings.defaultCapacityHoursPerWeek },
    assigned: 0,
    accepted: 0,
    inProgress: 0,
    revision: 0,
    awaitingReview: 0,
    active: 0,
    dueToday: 0,
    dueWithin48h: 0,
    overdue: 0,
    paused: 0,
    completedThisWeek: 0,
    completedThisMonth: 0,
    revisionRate: null,
    score: 0,
    ratio: band.ratio,
    band: band.band,
    bandReason: band.reason,
  };
}

/**
 * `GET /api/workloads/:userId` → WorkloadDetail. Allowed for the user
 * themself (workloads.view_self) and for management (performance.view);
 * foreign / missing ids → 404. For photographers the job lists follow
 * photographer_id and the averages use the jobs they shot.
 */
export function getWorkloadDetail(db: DbLike, ctx: AuthContext, userId: string): WorkloadDetail {
  const target = loadUserInOrg(db, ctx, userId);
  if (target.id === ctx.userId) assertCan(ctx, "workloads.view_self");
  else assertCan(ctx, "performance.view");

  const now = ctx.now();
  const tz = ctx.settings.timezone;
  const computation = computeWorkloads(db, ctx, { now, editorIds: [target.id] });
  const row = computation.rows[0] ?? emptyRow(target, computation.settings);
  const asPhotographer = target.role === "photographer";
  const holder = asPhotographer ? jobs.photographerId : jobs.editorId;

  const currentJobs = selectJobRows(db, ctx, { where: and(eq(holder, target.id), categoryIn(CATEGORY_GROUPS.ACTIVE)) });
  const overdueJobs = currentJobs.filter((j) => j.isOverdue);
  const recentCompleted = selectJobRows(db, ctx, {
    where: and(eq(holder, target.id), eq(jobs.statusCategory, "completed")),
    orderBy: [desc(jobs.completedAt), asc(jobs.id)],
    limit: 10,
  });

  const last30 = lastDaysRange(ctx, now, 30);
  const approved = approvedJobsInRange(db, ctx, last30, { scope: "org", where: asPhotographer ? eq(jobs.photographerId, target.id) : undefined }).filter(
    (j) => asPhotographer || j.approvingEditorId === target.id,
  );
  const transitions = loadTransitionsByJob(
    db,
    ctx,
    approved.map((j) => j.id),
  );
  const tOf = (id: string) => transitions.get(id) ?? [];

  const editorTransitions = asPhotographer ? [] : loadEditorTransitions(db, ctx, target.id, { enteredFrom: lastDaysRange(ctx, now, 90).from });

  return {
    ...row,
    currentJobs,
    overdueJobs,
    recentCompleted,
    avgTurnaroundSeconds: mean(approved.map((j) => turnaroundSeconds(j, tOf(j.id)))),
    avgEditingSeconds: mean(approved.map((j) => editingSeconds(tOf(j.id), now, asPhotographer ? undefined : target.id))),
    avgReviewSeconds: mean(approved.map((j) => reviewSeconds(tOf(j.id), now))),
    onTimePercent: toPercent(onTimeRate(approved).rate),
    secondsPerCategory: asPhotographer ? {} : avgSecondsPerCategory(editorTransitions, target.id),
    history: asPhotographer ? [] : workloadHistory(db, ctx, target.id, now, tz, computation.settings),
  };
}

/** Last 30 civil days of held-job count / score for one editor (§8 historical workload). */
export function workloadHistory(db: DbLike, ctx: AuthContext, editorId: string, now: string, tz: string, settings: OrganisationSettings, days = 30) {
  const today = todayCivil(tz, new Date(now));
  const fromCivil = addCivilDays(today, -(days - 1));
  const range = lastDaysRange(ctx, now, days);
  const assignments: AssignmentLike[] = db
    .select({
      jobId: jobAssignments.jobId,
      userId: jobAssignments.userId,
      role: jobAssignments.role,
      assignedAt: jobAssignments.assignedAt,
      unassignedAt: jobAssignments.unassignedAt,
    })
    .from(jobAssignments)
    .where(
      and(
        eq(jobAssignments.organisationId, ctx.organisationId),
        eq(jobAssignments.userId, editorId),
        eq(jobAssignments.role, "editor"),
        lt(jobAssignments.assignedAt, range.to),
        or(isNull(jobAssignments.unassignedAt), gte(jobAssignments.unassignedAt, range.from)),
      ),
    )
    .all();
  const jobIds = [...new Set(assignments.map((a) => a.jobId))];
  if (jobIds.length === 0) return historicalWorkloadSeries([], [], { from: fromCivil, to: today, timeZone: tz, now }, { editorId });
  const transitions = [...loadTransitionsByJob(db, ctx, jobIds).values()].flat().map((t) => ({
    jobId: t.jobId ?? "",
    toCategory: t.toCategory,
    enteredAt: t.enteredAt,
    exitedAt: t.exitedAt,
  }));
  const jobTypeDefaults = loadJobTypeDefaultHours(db, ctx);
  const jobHours: Record<string, number> = {};
  for (const j of loadMetricJobs(db, ctx, { scope: "org", where: inArray(jobs.id, jobIds) })) {
    jobHours[j.id] = j.estimatedHours ?? jobTypeDefaults[j.jobTypeId] ?? settings.defaultEstimatedHours;
  }
  return historicalWorkloadSeries(assignments, transitions, { from: fromCivil, to: today, timeZone: tz, now }, {
    editorId,
    jobHours,
    defaultHours: settings.defaultEstimatedHours,
  });
}

/** True when the viewer may see other people's workload aggregates. */
export function canViewTeamWorkloads(ctx: AuthContext): boolean {
  return isManagement(ctx) || can(ctx, "workloads.view_team");
}

/** Number of active (non-terminal) jobs a user currently holds in either role. */
export function openJobCountFor(db: DbLike, ctx: AuthContext, userId: string): number {
  const row = db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(jobs)
    .where(
      and(
        eq(jobs.organisationId, ctx.organisationId),
        categoryIn(CATEGORY_GROUPS.ACTIVE),
        or(eq(jobs.editorId, userId), eq(jobs.photographerId, userId)),
      ),
    )
    .get();
  return row?.n ?? 0;
}

const COMPLETED_WORK_LIMIT = 200;
const COMPLETED_WORK_WEEKS = 8;

/**
 * `/team/users/[id]` "what did they work on": the person's finished jobs
 * (approved or completed within the range; editor_id for editors,
 * photographer_id for photographers) with on-time flags, plus completions per
 * 7-day bucket over the last 8 weeks. Same permission as getWorkloadDetail:
 * self (workloads.view_self) or management (performance.view). Rows follow
 * job visibility.
 */
export function getUserCompletedWork(db: DbLike, ctx: AuthContext, userId: string, rawRange?: unknown): UserCompletedWork {
  const target = loadUserInOrg(db, ctx, userId);
  if (target.id === ctx.userId) assertCan(ctx, "workloads.view_self");
  else assertCan(ctx, "performance.view");
  const range = resolveRangeInput(ctx, rawRange, undefined, { db });
  const holder = target.role === "photographer" ? jobs.photographerId : jobs.editorId;
  const within = (col: typeof jobs.completedAt | typeof jobs.approvedAt, from: string, to: string) => and(gte(col, from), lt(col, to));

  const raws = selectRawJobs(db, ctx, {
    where: and(
      eq(holder, target.id),
      categoryIn(CATEGORY_GROUPS.DONE),
      or(within(jobs.completedAt, range.from, range.to), within(jobs.approvedAt, range.from, range.to)),
    ),
    orderBy: [sql`coalesce(${jobs.completedAt}, ${jobs.approvedAt}) desc`, asc(jobs.id)],
    limit: COMPLETED_WORK_LIMIT,
  });
  const rows = mapJobRows(db, ctx, raws);
  const items: CompletedWorkItem[] = raws.map((r, i) => ({
    job: rows[i],
    approvedAt: r.job.approvedAt,
    completedAt: r.job.completedAt,
    wasOnTime: r.job.wasOnTime,
  }));

  const tz = ctx.settings.timezone;
  const now = ctx.now();
  const today = todayCivil(tz, new Date(now));
  const firstWeek = addCivilDays(today, -(COMPLETED_WORK_WEEKS * 7 - 1));
  const from = startOfCivilDayIso(firstWeek, tz);
  const to = startOfCivilDayIso(addCivilDays(today, 1), tz);
  const done = completedJobsInRange(db, ctx, { from, to }, { scope: "org", where: eq(holder, target.id) });
  const weekly = Array.from({ length: COMPLETED_WORK_WEEKS }, (_, i) => ({ week: addCivilDays(firstWeek, i * 7), completed: 0, onTime: 0, late: 0 }));
  for (const j of done) {
    const day = civilDate(j.completedAt, tz);
    if (!day) continue;
    const bucket = weekly[Math.floor(civilDiffDays(firstWeek, day) / 7)];
    if (!bucket) continue;
    bucket.completed += 1;
    if (j.wasOnTime === true) bucket.onTime += 1;
    else if (j.wasOnTime === false) bucket.late += 1;
  }
  return { range, items, weekly };
}
