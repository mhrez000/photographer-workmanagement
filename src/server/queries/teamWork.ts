/**
 * Team Work (ARCHITECTURE.md §10 `/workspace/team`): active jobs grouped by
 * assignee with per-person counts.
 *
 * - Jobs come through `visibleJobsWhere(ctx)` (+ the All Work filter
 *   vocabulary), ACTIVE categories only.
 * - Groups: by editor (default) or photographer; jobs without that person
 *   are omitted (they live in All Work → Unassigned).
 * - Photographers / editors only get groups for themselves and their active
 *   teammates.
 * - `workload` (aggregate WorkloadRow) is filled for editors when the actor
 *   passes `workloads.view_team`, or for the actor's own group; otherwise null.
 *   It is computed from the editor's active jobs (§8 formulas in
 *   src/lib/metrics.ts); completed counts use `completedInRange` semantics and
 *   the revision rate covers jobs approved in the last 30 days whose current
 *   editor is the person.
 */
import { and, asc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "@/db/index";
import { jobTypes, jobs, users } from "@/db/schema";
import { CATEGORY_GROUPS, WORKLOAD_THRESHOLDS } from "@/lib/constants";
import { civilMonthRange, startOfCivilDayIso } from "@/lib/dates";
import { isDueWithinHours, revisionRate, workloadBand, workloadScore, type WorkloadSettings } from "@/lib/metrics";
import type { AuthContext, JobRow, OrganisationSettings, TeamWorkGroup, WorkloadRow } from "@/lib/types";
import { can, isManagement } from "@/server/auth/permissions";
import { parseInput } from "@/server/services/_shared";
import { jobFiltersWhere, JobListFiltersSchema } from "./jobs";
import {
  categoryIn,
  defaultJobOrder,
  jobRowQuery,
  loadOrgSettingsRow,
  mapJobRows,
  orgDayBounds,
  selectJobRows,
  visibleJobsWhere,
  type OrgDayBounds,
  type RawJobRow,
} from "./scope";

export const TeamWorkQuerySchema = JobListFiltersSchema.extend({
  role: z.preprocess((v) => (Array.isArray(v) ? v[0] : v === "" ? undefined : v), z.enum(["editor", "photographer"]).default("editor")),
});
export type TeamWorkQueryInput = z.input<typeof TeamWorkQuerySchema>;

const MAX_JOBS = 2000;

function workloadSettingsOf(s: OrganisationSettings | undefined): WorkloadSettings {
  if (!s) return {};
  return {
    defaultEstimatedHours: s.defaultEstimatedHours,
    defaultCapacityHoursPerWeek: s.defaultCapacityHoursPerWeek,
    workloadNearCapacityRatio: s.workloadNearCapacityRatio,
    workloadOverloadedRatio: s.workloadOverloadedRatio,
    maxActiveJobsPerEditor: s.maxActiveJobsPerEditor,
  };
}

interface CompletedCounts {
  week: number;
  month: number;
}

async function completedCounts(db: DbLike, ctx: AuthContext, editorIds: readonly string[], bounds: OrgDayBounds): Promise<Map<string, CompletedCounts>> {
  const out = new Map<string, CompletedCounts>();
  if (editorIds.length === 0) return out;
  const tz = ctx.settings.timezone;
  const [mStart, mEnd] = civilMonthRange(bounds.today);
  const month = { from: startOfCivilDayIso(mStart, tz), to: startOfCivilDayIso(mEnd, tz) };
  const from = month.from < bounds.weekStart ? month.from : bounds.weekStart;
  const to = month.to > bounds.weekEnd ? month.to : bounds.weekEnd;
  const rows = await db
    .select({ editorId: jobs.editorId, completedAt: jobs.completedAt })
    .from(jobs)
    .where(
      and(
        eq(jobs.organisationId, ctx.organisationId),
        inArray(jobs.editorId, [...editorIds]),
        eq(jobs.statusCategory, "completed"),
        gte(jobs.completedAt, from),
        lt(jobs.completedAt, to),
      ),
    );
  for (const r of rows) {
    if (!r.editorId || !r.completedAt) continue;
    const c = out.get(r.editorId) ?? { week: 0, month: 0 };
    if (r.completedAt >= bounds.weekStart && r.completedAt < bounds.weekEnd) c.week += 1;
    if (r.completedAt >= month.from && r.completedAt < month.to) c.month += 1;
    out.set(r.editorId, c);
  }
  return out;
}

async function approvedForRate(
  db: DbLike,
  ctx: AuthContext,
  editorIds: readonly string[],
  since: string,
): Promise<Map<string, { approvedAt: string | null; revisionCount: number }[]>> {
  const out = new Map<string, { approvedAt: string | null; revisionCount: number }[]>();
  if (editorIds.length === 0) return out;
  const rows = await db
    .select({ editorId: jobs.editorId, approvedAt: jobs.approvedAt, revisionCount: jobs.revisionCount })
    .from(jobs)
    .where(and(eq(jobs.organisationId, ctx.organisationId), inArray(jobs.editorId, [...editorIds]), isNotNull(jobs.approvedAt), gte(jobs.approvedAt, since)))
    .orderBy(asc(jobs.approvedAt), asc(jobs.id));
  for (const r of rows) {
    if (!r.editorId) continue;
    out.set(r.editorId, [...(out.get(r.editorId) ?? []), { approvedAt: r.approvedAt, revisionCount: r.revisionCount }]);
  }
  return out;
}

/** Aggregate WorkloadRow for one editor from their active jobs. */
export function buildWorkloadRow(
  editor: { id: string; name: string; role: WorkloadRow["editor"]["role"]; avatarColour: string; isActive: boolean; capacityHoursPerWeek: number | null },
  active: readonly JobRow[],
  opts: {
    settings: WorkloadSettings;
    jobTypeDefaults: Readonly<Record<string, number | null>>;
    now: string;
    completed: CompletedCounts;
    approved: readonly { approvedAt: string | null; revisionCount: number }[];
  },
): WorkloadRow {
  const capacity = editor.capacityHoursPerWeek ?? opts.settings.defaultCapacityHoursPerWeek ?? WORKLOAD_THRESHOLDS.defaultCapacityHoursPerWeek;
  const count = (fn: (j: JobRow) => boolean) => active.filter(fn).length;
  const overdue = count((j) => j.isOverdue);
  const activeCount = active.length;
  const score = workloadScore(
    active.map((j) => ({ statusCategory: j.statusCategory, priority: j.priority, dueDate: j.dueDate, estimatedHours: j.estimatedHours, jobTypeId: j.jobType.id })),
    { settings: opts.settings, jobTypeDefaults: opts.jobTypeDefaults, now: opts.now },
  );
  const band = workloadBand(score, { capacityHours: capacity, settings: opts.settings, activeCount, overdueCount: overdue, isActive: editor.isActive });
  return {
    editor: { id: editor.id, name: editor.name, role: editor.role, avatarColour: editor.avatarColour, isActive: editor.isActive, capacityHoursPerWeek: capacity },
    assigned: count((j) => j.statusCategory === "assigned"),
    accepted: count((j) => j.statusCategory === "accepted"),
    inProgress: count((j) => j.statusCategory === "in_progress"),
    revision: count((j) => j.statusCategory === "revision"),
    awaitingReview: count((j) => CATEGORY_GROUPS.REVIEWER_HOLDS.includes(j.statusCategory)),
    active: activeCount,
    dueToday: count((j) => j.isDueToday),
    dueWithin48h: count((j) => CATEGORY_GROUPS.DEADLINE_BOUND.includes(j.statusCategory) && !j.isOverdue && isDueWithinHours(j.dueDate, opts.now, WORKLOAD_THRESHOLDS.dueSoonHours)),
    overdue,
    paused: count((j) => j.isPaused),
    completedThisWeek: opts.completed.week,
    completedThisMonth: opts.completed.month,
    revisionRate: revisionRate(opts.approved).rate,
    score,
    ratio: band.ratio,
    band: band.band,
    bandReason: band.reason,
  };
}

/** Team Work groups (see file header). */
export async function getTeamWork(db: DbLike, ctx: AuthContext, input: unknown = {}): Promise<TeamWorkGroup[]> {
  const q = parseInput(TeamWorkQuerySchema, input ?? {});
  const now = ctx.now();
  const settingsRow = await loadOrgSettingsRow(db, ctx);
  const bounds = orgDayBounds(ctx, now, settingsRow?.weekStartsOn ?? 1);
  const personCol = q.role === "editor" ? jobs.editorId : jobs.photographerId;

  const allowedPeople: string[] | null = isManagement(ctx) || ctx.isSystem ? null : [...ctx.teamUserIds, ...(ctx.userId ? [ctx.userId] : [])];
  const where = and(
    jobFiltersWhere(ctx, q, bounds),
    categoryIn(CATEGORY_GROUPS.ACTIVE),
    isNotNull(personCol),
    allowedPeople ? inArray(personCol, allowedPeople.length ? allowedPeople : ["__none__"]) : undefined,
  );
  const rows = await selectJobRows(db, ctx, {
    where,
    orderBy: [sql`${jobs.dueDate} asc nulls last`, sql`${jobs.createdAt} desc`, sql`${jobs.id} asc`],
    limit: MAX_JOBS,
  });

  const byPerson = new Map<string, JobRow[]>();
  for (const r of rows) {
    const person = q.role === "editor" ? r.editor : r.photographer;
    if (!person) continue;
    byPerson.set(person.id, [...(byPerson.get(person.id) ?? []), r]);
  }
  const personIds = [...byPerson.keys()];
  if (personIds.length === 0) return [];

  const people = await db
    .select({ id: users.id, name: users.name, role: users.role, avatarColour: users.avatarColour, isActive: users.isActive, capacityHoursPerWeek: users.capacityHoursPerWeek })
    .from(users)
    .where(and(eq(users.organisationId, ctx.organisationId), inArray(users.id, personIds)));
  const peopleById = new Map(people.map((p) => [p.id, p]));

  // Workload aggregates (editors only, gated).
  const mayViewTeam = can(ctx, "workloads.view_team");
  const workloadIds = q.role === "editor" ? personIds.filter((id) => mayViewTeam || id === ctx.userId) : [];
  let workloads = new Map<string, WorkloadRow>();
  if (workloadIds.length > 0) {
    const settings = workloadSettingsOf(settingsRow);
    const jobTypeDefaults: Record<string, number | null> = {};
    for (const jt of await db
      .select({ id: jobTypes.id, hours: jobTypes.defaultEstimatedHours })
      .from(jobTypes)
      .where(eq(jobTypes.organisationId, ctx.organisationId))) {
      jobTypeDefaults[jt.id] = jt.hours;
    }
    // Workload = aggregate over ALL of the editor's active jobs (org-scoped, not
    // visibility-scoped: workloads.view_team grants aggregates, never the rows).
    const activeByEditor = new Map<string, JobRow[]>();
    const aggregateRaws = (await jobRowQuery(db)
      .where(and(eq(jobs.organisationId, ctx.organisationId), inArray(jobs.editorId, workloadIds), categoryIn(CATEGORY_GROUPS.ACTIVE)))
      .orderBy(...defaultJobOrder())
      .limit(MAX_JOBS)) as RawJobRow[];
    for (const r of await mapJobRows(db, ctx, aggregateRaws, now)) {
      if (r.editor) activeByEditor.set(r.editor.id, [...(activeByEditor.get(r.editor.id) ?? []), r]);
    }
    const completed = await completedCounts(db, ctx, workloadIds, bounds);
    const since = new Date(Date.parse(now) - 30 * 86_400_000).toISOString();
    const approved = await approvedForRate(db, ctx, workloadIds, since);
    workloads = new Map(
      workloadIds
        .map((id) => {
          const p = peopleById.get(id);
          if (!p) return null;
          const editorActive = (activeByEditor.get(id) ?? []).filter((j) => CATEGORY_GROUPS.ACTIVE.includes(j.statusCategory));
          return [
            id,
            buildWorkloadRow(p, editorActive, {
              settings,
              jobTypeDefaults,
              now,
              completed: completed.get(id) ?? { week: 0, month: 0 },
              approved: approved.get(id) ?? [],
            }),
          ] as const;
        })
        .filter((x): x is readonly [string, WorkloadRow] => x !== null),
    );
  }

  const groups: TeamWorkGroup[] = personIds
    .map((id) => {
      const p = peopleById.get(id);
      if (!p) return null;
      return {
        user: { id: p.id, name: p.name, role: p.role, avatarColour: p.avatarColour, isActive: p.isActive },
        workload: workloads.get(id) ?? null,
        jobs: byPerson.get(id) ?? [],
      };
    })
    .filter((g): g is TeamWorkGroup => g !== null);
  groups.sort((a, b) => a.user.name.localeCompare(b.user.name));
  return groups;
}

/** Visible-job count per person (cheap badge helper for the Team Work tabs). */
export async function teamWorkCounts(db: DbLike, ctx: AuthContext, role: "editor" | "photographer" = "editor"): Promise<Map<string, number>> {
  const col = role === "editor" ? jobs.editorId : jobs.photographerId;
  const rows = await db
    .select({ id: col, n: sql<number>`count(*)` })
    .from(jobs)
    .where(and(visibleJobsWhere(ctx), categoryIn(CATEGORY_GROUPS.ACTIVE), isNotNull(col)))
    .groupBy(col);

  return new Map(rows.filter((r): r is { id: string; n: number } => r.id !== null).map((r) => [r.id, Number(r.n)]));
}
