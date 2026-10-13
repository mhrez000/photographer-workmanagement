/**
 * The simplified Editors page (docs/SIMPLIFICATION-PLAN.md §7): one row per
 * editor with five plain numbers, the "Waiting on you" line, the extra
 * photographers table, the editor detail page and the CSV download.
 *
 * Formulas live in `src/lib/editorMetrics.ts` and are shared with the editor's
 * My jobs footer and Home → "Your editors", so every screen shows the same
 * number for the same thing:
 *   On their desk = jobs held now (With editor + Changes asked)
 *   Late now      = of those, due day before today (org tz)
 *   Finished      = approvals in the period credited to the editor
 *                   (`approvingEditorId`: editor_id_at_entry of the approval)
 *   On time       = % of finished jobs FIRST sent for checking on/before the due day
 *   Needed changes= % of finished jobs with ≥ 1 round of changes
 * Below MIN_JOBS_FOR_RATES finished jobs both percentages are null ("Not enough jobs yet").
 *
 * Access: owners / co-owners (admins) and members with the analytics switch
 * (`performance.view`). Clients and editors → 403.
 */
import { and, asc, eq, inArray, isNotNull, ne, sql, type SQL } from "drizzle-orm";
import type { DbLike } from "@/db/index";
import { jobs, users } from "@/db/schema";
import { buildCsv, csvFileName } from "@/lib/csv";
import {
  averageDaysToEdit,
  daysLateBySubmit,
  EDITOR_PERIODS,
  finishedPerWeek,
  isDeskFull,
  neededChangesPct,
  numberDelta,
  onTimeBySubmitPct,
  periodRange,
  previousPeriodRange,
  submittedOnTime,
  weekBuckets,
} from "@/lib/editorMetrics";
import { todayCivil } from "@/lib/dates";
import { firstEnter } from "@/lib/metrics";
import { categoriesForStage } from "@/lib/stages";
import type {
  AuthContext,
  EditorDetail,
  EditorFiveNumbers,
  EditorOverviewRow,
  EditorPeriodKey,
  EditorPeriodRange,
  EditorPickerOption,
  EditorsCsv,
  EditorsOverview,
  ExtraPhotographerRow,
  UserRef,
} from "@/lib/types";
import { can, isAdmin, managedJobsWhere } from "@/server/auth/permissions";
import { loadJobRefs } from "@/server/auth/job-ref";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { lateWhere, selectSimpleRows, simpleBounds } from "./jobsSimple";
import { approvedJobsInRange, binaryAsc, loadTransitionsByJob, type ApprovedMetricJob } from "./metrics";
import { assertStaffRead, categoryIn, loadOrgSettingsRow, type OrgDayBounds } from "./scope";
import { loadUsualCapacities } from "./simpleColumns";

export const RECENTLY_FINISHED_LIMIT = 20;
export const FINISHED_WEEKS = 12;
const DAY_MS = 86_400_000;

/** Categories on an editor's desk: With editor + Changes asked. */
export const ON_DESK_CATEGORIES = [...categoriesForStage("with_editor"), ...categoriesForStage("changes_asked")];

/* ------------------------------------------------------------------ */
/*  Access                                                             */
/* ------------------------------------------------------------------ */

/** Owners / co-owners, or members with the analytics switch. */
export function canSeeEditorsPage(ctx: AuthContext): boolean {
  return ctx.isActive && (isAdmin(ctx) || can(ctx, "performance.view"));
}

export function assertEditorsPage(ctx: AuthContext): void {
  assertStaffRead(ctx);
  if (!canSeeEditorsPage(ctx)) throw new ForbiddenError("performance.view", "The Editors page is for the studio owner");
}

export function parsePeriod(value: unknown): EditorPeriodKey {
  const v = Array.isArray(value) ? value[0] : value;
  return (EDITOR_PERIODS as readonly string[]).includes(String(v)) ? (v as EditorPeriodKey) : "this_month";
}

/* ------------------------------------------------------------------ */
/*  Desk counts                                                        */
/* ------------------------------------------------------------------ */

export interface DeskCounts {
  onDesk: number;
  late: number;
}

/** `jobs.editor_id = E` ∧ on-desk categories (optionally for given editors). */
export function onDeskWhere(editorIds?: readonly string[]): SQL {
  return and(isNotNull(jobs.editorId), categoryIn(ON_DESK_CATEGORIES), editorIds ? inArray(jobs.editorId, [...editorIds]) : undefined) as SQL;
}

/** On their desk + late now per editor, org-wide (one GROUP BY). */
export async function loadDeskCounts(db: DbLike, ctx: AuthContext, bounds: OrgDayBounds, editorIds?: readonly string[]): Promise<Map<string, DeskCounts>> {
  const out = new Map<string, DeskCounts>();
  if (editorIds && editorIds.length === 0) return out;
  const rows = await db
    .select({
      editorId: jobs.editorId,
      onDesk: sql<number>`count(*)`.mapWith(Number),
      late: sql<number>`sum(case when ${lateWhere(bounds)} then 1 else 0 end)`.mapWith(Number),
    })
    .from(jobs)
    .where(and(eq(jobs.organisationId, ctx.organisationId), onDeskWhere(editorIds)))
    .groupBy(jobs.editorId);
  for (const r of rows) if (r.editorId) out.set(r.editorId, { onDesk: r.onDesk || 0, late: r.late || 0 });
  return out;
}

const USER_REF = { id: users.id, name: users.name, role: users.role, avatarColour: users.avatarColour, isActive: users.isActive };

/** Active editors of the org (name order), plus any other editor in `extraIds` (e.g. a deactivated one still credited). */
async function loadEditors(db: DbLike, ctx: AuthContext, extraIds: readonly string[] = []): Promise<UserRef[]> {
  const extra = [...new Set(extraIds)];
  return db
    .select(USER_REF)
    .from(users)
    .where(
      and(
        eq(users.organisationId, ctx.organisationId),
        eq(users.role, "editor"),
        extra.length > 0 ? sql`(${users.isActive} or ${inArray(users.id, extra)})` : eq(users.isActive, true),
      ),
    )
    .orderBy(binaryAsc(users.name), asc(users.id));
}

/**
 * Rows for the Assign / Change editor picker: every active editor with
 * "On their desk N · Late N" and the optional usual capacity. Photographers
 * (owner, co-owners, extra photographers — the people who assign) read it;
 * editors never: the list of editors is the studio roster (plan §2, E17), and
 * an editor who creates a job is only ever its own editor.
 */
export async function editorPickerOptions(db: DbLike, ctx: AuthContext): Promise<EditorPickerOption[]> {
  assertStaffRead(ctx);
  if (!ctx.isSystem && ctx.role !== "photographer") throw new ForbiddenError("job.assign_editor", "Only photographers give jobs to editors");
  const bounds = await simpleBounds(db, ctx);
  const editors = await loadEditors(db, ctx);
  const desk = await loadDeskCounts(
    db,
    ctx,
    bounds,
    editors.map((e) => e.id),
  );
  const capacities = await loadUsualCapacities(
    db,
    ctx,
    editors.map((e) => e.id),
  );
  return editors.map((editor) => {
    const d = desk.get(editor.id) ?? { onDesk: 0, late: 0 };
    const usualCapacity = capacities.get(editor.id) ?? null;
    return { editor, onDesk: d.onDesk, late: d.late, usualCapacity, full: isDeskFull(d.onDesk, usualCapacity) };
  });
}

/* ------------------------------------------------------------------ */
/*  Finished jobs credited to editors                                  */
/* ------------------------------------------------------------------ */

/** Approvals in `range` grouped by the credited editor (org-wide). */
async function finishedByEditor(db: DbLike, ctx: AuthContext, range: EditorPeriodRange): Promise<Map<string, ApprovedMetricJob[]>> {
  const approved = await approvedJobsInRange(db, ctx, { from: range.from, to: range.to }, { scope: "org" });
  const out = new Map<string, ApprovedMetricJob[]>();
  for (const j of approved) {
    if (!j.approvingEditorId) continue;
    out.set(j.approvingEditorId, [...(out.get(j.approvingEditorId) ?? []), j]);
  }
  return out;
}

/** The five numbers from desk counts + finished jobs (shared by rows, detail, Home and My jobs). */
export function fiveNumbers(desk: DeskCounts | undefined, finished: readonly ApprovedMetricJob[], timeZone: string): EditorFiveNumbers {
  const onTime = onTimeBySubmitPct(finished, timeZone);
  const changes = neededChangesPct(finished);
  return {
    onDesk: desk?.onDesk ?? 0,
    lateNow: desk?.late ?? 0,
    finished: finished.length,
    onTimePct: onTime.pct,
    neededChangesPct: changes.pct,
    notEnough: onTime.notEnough || changes.notEnough,
  };
}

/** Rows sorted "Late now" first, then the fullest desk, then name. */
export function sortOverviewRows(rows: EditorOverviewRow[]): EditorOverviewRow[] {
  return [...rows].sort((a, b) => b.lateNow - a.lateNow || b.onDesk - a.onDesk || a.editor.name.localeCompare(b.editor.name) || a.editor.id.localeCompare(b.editor.id));
}

/** Every editor row for a period (no permission check — callers gate). */
export async function computeEditorRows(db: DbLike, ctx: AuthContext, period: EditorPeriodKey, now: string = ctx.now()): Promise<EditorOverviewRow[]> {
  const tz = ctx.settings.timezone;
  const bounds = await simpleBounds(db, ctx, now);
  const range = periodRange(period, tz, now);
  const finished = await finishedByEditor(db, ctx, range);
  const desk = await loadDeskCounts(db, ctx, bounds);
  const editors = await loadEditors(db, ctx, [...finished.keys(), ...desk.keys()]);
  const capacities = await loadUsualCapacities(
    db,
    ctx,
    editors.map((e) => e.id),
  );
  return sortOverviewRows(
    editors.map((editor) => {
      const numbers = fiveNumbers(desk.get(editor.id), finished.get(editor.id) ?? [], tz);
      const usualCapacity = capacities.get(editor.id) ?? null;
      return { editor, ...numbers, usualCapacity, full: isDeskFull(numbers.onDesk, usualCapacity) };
    }),
  );
}

/* ------------------------------------------------------------------ */
/*  Waiting on you + extra photographers                                */
/* ------------------------------------------------------------------ */

/** Jobs ready to check across the org: count + age of the oldest (seconds since it was sent). */
export async function waitingOnYou(db: DbLike, ctx: AuthContext, now: string, where?: SQL): Promise<{ count: number; oldestAgeSeconds: number | null }> {
  const rows = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number), oldest: sql<string | null>`min(coalesce(${jobs.lastSubmittedAt}, ${jobs.statusEnteredAt}))` })
    .from(jobs)
    .where(and(eq(jobs.organisationId, ctx.organisationId), categoryIn(categoriesForStage("ready_to_check")), where));
  const r = rows[0];
  const count = r?.n || 0;
  const oldest = r?.oldest ?? null;
  return { count, oldestAgeSeconds: count > 0 && oldest ? Math.max(0, Math.floor((Date.parse(now) - Date.parse(oldest)) / 1000)) : null };
}

/** The small table of non-admin photographers: shoots in the period, jobs waiting for their check, late jobs they manage. */
export async function extraPhotographerRows(db: DbLike, ctx: AuthContext, range: EditorPeriodRange, bounds: OrgDayBounds): Promise<ExtraPhotographerRow[]> {
  const people = await db
    .select(USER_REF)
    .from(users)
    .where(and(eq(users.organisationId, ctx.organisationId), eq(users.role, "photographer"), eq(users.isActive, true), eq(users.isAdmin, false)))
    .orderBy(binaryAsc(users.name), asc(users.id));
  if (people.length === 0) return [];
  const managedBy = (id: string) => managedJobsWhere({ ...ctx, role: "photographer", userId: id });
  const out: ExtraPhotographerRow[] = [];
  for (const photographer of people) {
    const row = (
      await db
        .select({
          shoots: sql<number>`sum(case when ${jobs.photographerId} = ${photographer.id} and ${jobs.shootDate} > ${range.from} and ${jobs.shootDate} <= ${range.to} and ${ne(jobs.statusCategory, "cancelled")} then 1 else 0 end)`.mapWith(Number),
          waiting: sql<number>`sum(case when ${categoryIn(categoriesForStage("ready_to_check"))} then 1 else 0 end)`.mapWith(Number),
          late: sql<number>`sum(case when ${lateWhere(bounds)} then 1 else 0 end)`.mapWith(Number),
        })
        .from(jobs)
        .where(and(eq(jobs.organisationId, ctx.organisationId), managedBy(photographer.id)))
    )[0];
    out.push({ photographer, shootsThisPeriod: row?.shoots || 0, waitingForTheirCheck: row?.waiting || 0, late: row?.late || 0 });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  getEditorsOverview                                                 */
/* ------------------------------------------------------------------ */

export async function getEditorsOverview(db: DbLike, ctx: AuthContext, input: { period?: unknown } = {}): Promise<EditorsOverview> {
  assertEditorsPage(ctx);
  const now = ctx.now();
  const period = parsePeriod(input.period);
  const range = periodRange(period, ctx.settings.timezone, now);
  const bounds = await simpleBounds(db, ctx, now);
  return {
    period: range,
    waitingOnYou: await waitingOnYou(db, ctx, now),
    rows: await computeEditorRows(db, ctx, period, now),
    extraPhotographers: await extraPhotographerRows(db, ctx, range, bounds),
    asOf: now,
  };
}

/* ------------------------------------------------------------------ */
/*  getEditorDetail                                                    */
/* ------------------------------------------------------------------ */

export async function loadEditorInOrg(db: DbLike, ctx: AuthContext, editorId: string): Promise<UserRef> {
  const row = (await db.select(USER_REF).from(users).where(and(eq(users.organisationId, ctx.organisationId), eq(users.id, editorId))))[0];
  if (!row || row.role !== "editor") throw new NotFoundError("Editor");
  return row;
}

/** Approvals credited to `editorId` whose approved_at ∈ (range) — newest first. */
async function creditedApprovals(db: DbLike, ctx: AuthContext, editorId: string, range: { from: string; to: string }): Promise<ApprovedMetricJob[]> {
  const all = await approvedJobsInRange(db, ctx, range, { scope: "org" });
  return all.filter((j) => j.approvingEditorId === editorId).sort((a, b) => (b.approvedAt ?? "").localeCompare(a.approvedAt ?? "") || a.id.localeCompare(b.id));
}

export async function getEditorDetail(db: DbLike, ctx: AuthContext, editorId: string, input: { period?: unknown } = {}): Promise<EditorDetail> {
  assertEditorsPage(ctx);
  const now = ctx.now();
  const tz = ctx.settings.timezone;
  const editor = await loadEditorInOrg(db, ctx, editorId);
  const period = parsePeriod(input.period);
  const range = periodRange(period, tz, now);
  const previous = previousPeriodRange(period, tz, now);
  const bounds = await simpleBounds(db, ctx, now);
  const desk = (await loadDeskCounts(db, ctx, bounds, [editor.id])).get(editor.id);
  const finishedNow = await creditedApprovals(db, ctx, editor.id, range);
  const finishedBefore = await creditedApprovals(db, ctx, editor.id, previous);
  const numbers = fiveNumbers(desk, finishedNow, tz);
  const before = fiveNumbers(undefined, finishedBefore, tz);
  const usualCapacity = (await loadUsualCapacities(db, ctx, [editor.id])).get(editor.id) ?? null;

  // On their desk now (visible to the viewer; admins see every job).
  const onDeskRows = await selectSimpleRows(db, ctx, bounds, { where: and(eq(jobs.editorId, editor.id), categoryIn(ON_DESK_CATEGORIES)) });
  const refs = await loadJobRefs(
    db,
    ctx,
    onDeskRows.map((r) => r.id),
  );
  const onDeskNow = onDeskRows.map((job) => {
    const ref = refs.get(job.id)?.ref;
    return { job, canChangeEditor: ref !== undefined && can(ctx, "job.assign_editor", ref) };
  });

  // Recently finished (last 20 within the past year) + 12-week series.
  const yearAgo = new Date(Date.parse(now) - 365 * DAY_MS).toISOString();
  const recent = (await creditedApprovals(db, ctx, editor.id, { from: yearAgo, to: new Date(Date.parse(now) + DAY_MS).toISOString() })).slice(0, RECENTLY_FINISHED_LIMIT);
  const recentRows = recent.length ? await selectSimpleRows(db, ctx, bounds, { where: inArray(jobs.id, recent.map((j) => j.id)) }) : [];
  const rowById = new Map(recentRows.map((r) => [r.id, r]));
  const recentlyFinished = recent.flatMap((j) => {
    const job = rowById.get(j.id);
    if (!job || !j.approvedAt) return [];
    return [{ job, approvedAt: j.approvedAt, onTime: submittedOnTime(j, tz), daysLate: daysLateBySubmit(j, tz), rounds: j.revisionCount }];
  });
  const weekStartsOn = (await loadOrgSettingsRow(db, ctx))?.weekStartsOn ?? 1;
  const buckets = weekBuckets(now, tz, weekStartsOn, FINISHED_WEEKS);
  const inWeeks = await creditedApprovals(db, ctx, editor.id, { from: buckets[0].from, to: buckets[buckets.length - 1].to });

  return {
    editor,
    period: range,
    numbers,
    usualCapacity,
    full: isDeskFull(numbers.onDesk, usualCapacity),
    deltas: {
      onDesk: numberDelta(numbers.onDesk, null),
      lateNow: numberDelta(numbers.lateNow, null),
      finished: numberDelta(numbers.finished, before.finished),
      onTimePct: numberDelta(numbers.onTimePct, before.onTimePct),
      neededChangesPct: numberDelta(numbers.neededChangesPct, before.neededChangesPct),
    },
    onDeskNow,
    recentlyFinished,
    finishedPerWeek: finishedPerWeek(
      inWeeks.flatMap((j) => (j.approvedAt ? [j.approvedAt] : [])),
      buckets,
    ),
    asOf: now,
  };
}

/* ------------------------------------------------------------------ */
/*  editorsCsv                                                         */
/* ------------------------------------------------------------------ */

export const EDITORS_CSV_HEADERS = ["Editor", "On their desk", "Late now", "Finished", "On time %", "Needed changes %", "Average days to edit", "Period"] as const;

/** The Editors table as CSV, plus "average days to edit" (approved − first time editing began). */
export async function editorsCsv(db: DbLike, ctx: AuthContext, input: { period?: unknown } = {}): Promise<EditorsCsv> {
  assertEditorsPage(ctx);
  const now = ctx.now();
  const tz = ctx.settings.timezone;
  const period = parsePeriod(input.period);
  const range = periodRange(period, tz, now);
  const rows = await computeEditorRows(db, ctx, period, now);
  const finished = await finishedByEditor(db, ctx, range);
  const transitions = await loadTransitionsByJob(
    db,
    ctx,
    [...finished.values()].flat().map((j) => j.id),
  );
  const avgDays = (editorId: string): number | null =>
    averageDaysToEdit(
      (finished.get(editorId) ?? []).map((j) => {
        const t = transitions.get(j.id) ?? [];
        return { approvedAt: j.approvedAt, editingStartedAt: firstEnter(t, "in_progress") ?? firstEnter(t, "assigned") ?? j.createdAt };
      }),
    );
  const csv = buildCsv(
    EDITORS_CSV_HEADERS,
    rows.map((r) => [r.editor.name, r.onDesk, r.lateNow, r.finished, r.notEnough ? "Not enough jobs yet" : r.onTimePct, r.notEnough ? "Not enough jobs yet" : r.neededChangesPct, avgDays(r.editor.id), range.label]),
    { bom: true },
  );
  return { fileName: csvFileName(`editors-${period}-${todayCivil(tz, new Date(now))}`), csv };
}

