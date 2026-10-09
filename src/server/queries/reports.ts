/**
 * Reports (ARCHITECTURE.md §9 `GET /api/reports/:kind?range&format=json|csv`,
 * §10 `/insights/reports`). Each report is a flat table (`Report`) so the
 * page and the CSV export render the same rows.
 *
 *   production    — one row per job touched in range (created, approved or
 *                   latest completion in range); rows follow job visibility
 *   editors       — PerformanceRow per editor (org aggregates)
 *   photographers — PhotographerPerformanceRow per photographer
 *   business      — per client: created / completed / overdue now /
 *                   turnaround / revision rate / on-time
 *
 * Durations are reported in hours (2 dp), rates as percentages (1 dp).
 * JSON keeps ISO instants; the CSV writes date columns in the organisation
 * timezone ("YYYY-MM-DD HH:mm", or the civil date for deadline columns) and
 * names the file after the range's civil dates.
 */
import { and, asc, eq, gte, inArray, lt, or } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "@/db/index";
import { clients, jobs } from "@/db/schema";
import { REPORT_KINDS, type ReportKind } from "@/lib/constants";
import { csvFileName, csvFromObjects, type CsvValue } from "@/lib/csv";
import { civilDate, DEFAULT_TIMEZONE, localDateTimeString } from "@/lib/dates";
import { isPastDue, onTimeRate, revisionRate, turnaroundSeconds } from "@/lib/metrics";
import type { AuthContext, Report, ReportCell, ReportColumn, ResolvedRange } from "@/lib/types";
import { isDeadlineBound } from "@/lib/workflow";
import { assertCan } from "@/server/auth/permissions";
import { NotFoundError } from "@/server/errors";
import {
  approvedJobsInRange,
  completedJobsInRange,
  createdJobsInRange,
  groupBy,
  loadActiveMetricJobs,
  loadMetricJobs,
  loadTransitionsByJob,
  mean,
  resolveRangeInput,
} from "./metrics";
import { computeEditorPerformance, computePhotographerPerformance } from "./performance";
import { selectJobRows } from "./scope";

const KindSchema = z.enum(REPORT_KINDS);

const hours = (seconds: number | null | undefined): number | null =>
  seconds === null || seconds === undefined || !Number.isFinite(seconds) ? null : Math.round((seconds / 3600) * 100) / 100;
const pct = (rate: number | null | undefined): number | null =>
  rate === null || rate === undefined || !Number.isFinite(rate) ? null : Math.round(rate * 1000) / 10;
const pct100 = (percent: number | null | undefined): number | null =>
  percent === null || percent === undefined || !Number.isFinite(percent) ? null : Math.round(percent * 10) / 10;

const col = (key: string, label: string, kind: ReportColumn["kind"] = "text"): ReportColumn => ({ key, label, kind });

const TITLES: Record<ReportKind, string> = {
  production: "Production report",
  editors: "Editors report",
  photographers: "Photographers report",
  business: "Business report",
};

/**
 * `GET /api/reports/:kind` (reports.view). Unknown kind → 404; bad range → 400.
 */
export function getReport(db: DbLike, ctx: AuthContext, kind: unknown, rawRange?: unknown): Report {
  assertCan(ctx, "reports.view");
  const parsed = KindSchema.safeParse(kind);
  if (!parsed.success) throw new NotFoundError("Report");
  const range = resolveRangeInput(ctx, rawRange, undefined, { db });
  return buildReport(db, ctx, parsed.data, range);
}

/** Report without the permission check (tests / scheduled exports). */
export function buildReport(db: DbLike, ctx: AuthContext, kind: ReportKind, range: ResolvedRange): Report {
  const base = { kind, title: `${TITLES[kind]} — ${range.label}`, range, generatedAt: ctx.now() };
  switch (kind) {
    case "production":
      return { ...base, ...productionTable(db, ctx, range) };
    case "editors":
      return { ...base, ...editorsTable(db, ctx, range) };
    case "photographers":
      return { ...base, ...photographersTable(db, ctx, range) };
    case "business":
      return { ...base, ...businessTable(db, ctx, range) };
  }
}

type Table = Pick<Report, "columns" | "rows" | "totals">;

function productionTable(db: DbLike, ctx: AuthContext, range: ResolvedRange): Table {
  const inRange = (column: typeof jobs.createdAt | typeof jobs.approvedAt | typeof jobs.completedAt) => and(gte(column, range.from), lt(column, range.to));
  const where = or(inRange(jobs.createdAt), inRange(jobs.approvedAt), and(eq(jobs.statusCategory, "completed"), inRange(jobs.completedAt)));
  const rows = selectJobRows(db, ctx, { where, orderBy: [asc(jobs.createdAt), asc(jobs.jobNumber)] });
  const ids = rows.map((r) => r.id);
  const facts = new Map(
    (ids.length === 0 ? [] : loadMetricJobs(db, ctx, { scope: "visible", where: inArray(jobs.id, ids) })).map((j) => [j.id, j]),
  );
  const transitions = loadTransitionsByJob(db, ctx, ids);
  const out = rows.map((r) => {
    const f = facts.get(r.id);
    const turnaround = f ? turnaroundSeconds(f, transitions.get(r.id) ?? []) : null;
    return {
      jobNumber: r.jobNumber,
      name: r.name,
      client: r.client.name,
      project: r.project.name,
      jobType: r.jobType.name,
      photographer: r.photographer?.name ?? null,
      editor: r.editor?.name ?? null,
      status: r.status.name,
      priority: r.priority,
      createdAt: r.createdAt,
      dueDate: r.dueDate,
      approvedAt: f?.approvedAt ?? null,
      completedAt: f?.completedAt ?? null,
      revisionCount: r.revisionCount,
      turnaroundHours: hours(turnaround),
      onTime: f?.wasOnTime ?? null,
    } satisfies Record<string, ReportCell>;
  });
  const factsList = [...facts.values()];
  // Totals are over jobs APPROVED in range (same population as Business / Analytics / Editors),
  // averaged from unrounded seconds — not over every touched row's rounded hours.
  const approvedInRange = factsList.filter((j) => j.approvedAt !== null && j.approvedAt >= range.from && j.approvedAt < range.to);
  return {
    columns: [
      col("jobNumber", "Job"),
      col("name", "Name"),
      col("client", "Client"),
      col("project", "Project"),
      col("jobType", "Job type"),
      col("photographer", "Photographer"),
      col("editor", "Editor"),
      col("status", "Status"),
      col("priority", "Priority"),
      col("createdAt", "Created", "date"),
      { ...col("dueDate", "Due", "date"), civil: true },
      col("approvedAt", "Approved", "date"),
      col("completedAt", "Completed", "date"),
      col("revisionCount", "Revisions", "number"),
      col("turnaroundHours", "Turnaround (h)", "hours"),
      col("onTime", "On time"),
    ],
    rows: out,
    totals: {
      jobNumber: "Total",
      name: `${out.length} jobs`,
      revisionCount: out.reduce((s, r) => s + r.revisionCount, 0),
      turnaroundHours: hours(mean(approvedInRange.map((j) => turnaroundSeconds(j, transitions.get(j.id) ?? [])))),
      onTime: pct(onTimeRate(approvedInRange).rate),
    },
  };
}

function editorsTable(db: DbLike, ctx: AuthContext, range: ResolvedRange): Table {
  const rows = computeEditorPerformance(db, ctx, range);
  return {
    columns: [
      col("editor", "Editor"),
      col("approved", "Approved", "number"),
      col("completed", "Completed", "number"),
      col("avgTurnaroundHours", "Avg turnaround (h)", "hours"),
      col("avgEditingHours", "Avg editing (h)", "hours"),
      col("avgReviewHours", "Avg review (h)", "hours"),
      col("revisionRate", "Revision rate %", "percent"),
      col("revisionsPerJob", "Revisions / job", "number"),
      col("onTimePercent", "On time %", "percent"),
      // WorkloadRow.active: editor-held + in-review jobs (WORKLOAD), not every open job.
      col("active", "Held now", "number"),
      col("overdue", "Overdue now", "number"),
    ],
    rows: rows.map((r) => ({
      editor: r.user.isActive ? r.user.name : `${r.user.name} (inactive)`,
      approved: r.approved,
      completed: r.completed,
      avgTurnaroundHours: hours(r.avgTurnaroundSeconds),
      avgEditingHours: hours(r.avgEditingSeconds),
      avgReviewHours: hours(r.avgReviewSeconds),
      revisionRate: pct(r.revisionRate),
      revisionsPerJob: r.revisionsPerJob === null ? null : Math.round(r.revisionsPerJob * 100) / 100,
      onTimePercent: pct100(r.onTimePercent),
      active: r.active,
      overdue: r.overdue,
    })),
    totals: {
      editor: "Total",
      approved: rows.reduce((s, r) => s + r.approved, 0),
      completed: rows.reduce((s, r) => s + r.completed, 0),
      active: rows.reduce((s, r) => s + r.active, 0),
      overdue: rows.reduce((s, r) => s + r.overdue, 0),
    },
  };
}

function photographersTable(db: DbLike, ctx: AuthContext, range: ResolvedRange): Table {
  const rows = computePhotographerPerformance(db, ctx, range);
  return {
    columns: [
      col("photographer", "Photographer"),
      col("created", "Created", "number"),
      col("submitted", "Submitted", "number"),
      col("completed", "Completed", "number"),
      col("avgProcessingHours", "Avg shoot → submitted (h)", "hours"),
      col("avgEndToEndHours", "Avg created → completed (h)", "hours"),
      col("avgReviewResponseHours", "Avg review time (h)", "hours"),
      col("active", "Active now", "number"),
      col("overdue", "Overdue now", "number"),
    ],
    rows: rows.map((r) => ({
      photographer: r.user.isActive ? r.user.name : `${r.user.name} (inactive)`,
      created: r.created,
      submitted: r.submitted,
      completed: r.completed,
      avgProcessingHours: hours(r.avgProcessingSeconds),
      avgEndToEndHours: hours(r.avgEndToEndSeconds),
      avgReviewResponseHours: hours(r.avgReviewResponseSeconds),
      active: r.active,
      overdue: r.overdue,
    })),
    totals: {
      photographer: "Total",
      created: rows.reduce((s, r) => s + r.created, 0),
      submitted: rows.reduce((s, r) => s + r.submitted, 0),
      completed: rows.reduce((s, r) => s + r.completed, 0),
      active: rows.reduce((s, r) => s + r.active, 0),
      overdue: rows.reduce((s, r) => s + r.overdue, 0),
    },
  };
}

function businessTable(db: DbLike, ctx: AuthContext, range: ResolvedRange): Table {
  const now = ctx.now();
  const scope = { scope: "org" as const };
  const created = groupBy(createdJobsInRange(db, ctx, range, scope), (j) => j.clientId);
  const completed = groupBy(completedJobsInRange(db, ctx, range, scope), (j) => j.clientId);
  const approvedList = approvedJobsInRange(db, ctx, range, scope);
  const approved = groupBy(approvedList, (j) => j.clientId);
  const overdue = groupBy(
    loadActiveMetricJobs(db, ctx, scope).filter((j) => isDeadlineBound(j.statusCategory) && isPastDue(j.dueDate, now)),
    (j) => j.clientId,
  );
  const transitions = loadTransitionsByJob(
    db,
    ctx,
    approvedList.map((j) => j.id),
  );
  const ids = [...new Set([...created.keys(), ...completed.keys(), ...approved.keys(), ...overdue.keys()])];
  const clientRows =
    ids.length === 0
      ? []
      : db
          .select({ id: clients.id, name: clients.name })
          .from(clients)
          .where(and(eq(clients.organisationId, ctx.organisationId), inArray(clients.id, ids)))
          .orderBy(asc(clients.name))
          .all();
  const rows = clientRows.map((c) => {
    const a = approved.get(c.id) ?? [];
    return {
      client: c.name,
      created: created.get(c.id)?.length ?? 0,
      completed: completed.get(c.id)?.length ?? 0,
      approved: a.length,
      overdue: overdue.get(c.id)?.length ?? 0,
      avgTurnaroundHours: hours(mean(a.map((j) => turnaroundSeconds(j, transitions.get(j.id) ?? [])))),
      revisionRate: pct(revisionRate(a).rate),
      onTimePercent: pct(onTimeRate(a).rate),
    };
  });
  return {
    columns: [
      col("client", "Client"),
      col("created", "Jobs created", "number"),
      col("completed", "Jobs completed", "number"),
      col("approved", "Jobs approved", "number"),
      col("overdue", "Overdue now", "number"),
      col("avgTurnaroundHours", "Avg turnaround (h)", "hours"),
      col("revisionRate", "Revision rate %", "percent"),
      col("onTimePercent", "On time %", "percent"),
    ],
    rows,
    totals: {
      client: "Total",
      created: rows.reduce((s, r) => s + r.created, 0),
      completed: rows.reduce((s, r) => s + r.completed, 0),
      approved: rows.reduce((s, r) => s + r.approved, 0),
      overdue: rows.reduce((s, r) => s + r.overdue, 0),
      avgTurnaroundHours: hours(mean(approvedList.map((j) => turnaroundSeconds(j, transitions.get(j.id) ?? [])))),
      revisionRate: pct(revisionRate(approvedList).rate),
      onTimePercent: pct(onTimeRate(approvedList).rate),
    },
  };
}

/* ------------------------------------------------------------------ */
/*  CSV                                                                */
/* ------------------------------------------------------------------ */

/**
 * The report as CSV (header row from column labels; totals appended as the
 * last row). Formula-safe. Date columns are written in `timeZone` (the
 * organisation's): "YYYY-MM-DD HH:mm", or the civil date for deadline
 * columns (`civil: true`).
 */
export function toCsv(report: Report, timeZone: string = DEFAULT_TIMEZONE): string {
  const rows = report.totals ? [...report.rows, report.totals] : report.rows;
  const dateCols = report.columns.filter((c) => c.kind === "date");
  const local = rows.map((r) => {
    if (dateCols.length === 0) return r;
    const out: Record<string, CsvValue> = { ...r };
    for (const c of dateCols) {
      const v = r[c.key];
      if (typeof v !== "string" || !Number.isFinite(Date.parse(v))) continue;
      out[c.key] = (c.civil ? civilDate(v, timeZone) : localDateTimeString(v, timeZone)) ?? v;
    }
    return out;
  });
  return csvFromObjects(report.columns, local);
}

/**
 * e.g. "editors-report-2026-10-01-2026-10-31.csv": the FIRST and LAST civil
 * day of the range in `timeZone` (the range end is exclusive, so the last day
 * is civil(to − 1 ms)).
 */
export function reportFileName(report: Report, timeZone: string = DEFAULT_TIMEZONE): string {
  const first = civilDate(report.range.from, timeZone) ?? report.range.from.slice(0, 10);
  const last = civilDate(new Date(Date.parse(report.range.to) - 1), timeZone) ?? report.range.to.slice(0, 10);
  return csvFileName(`${report.kind}-report-${first}-${last}`);
}
