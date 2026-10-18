/**
 * Kanban board (ARCHITECTURE.md §4.6 drop mapping, §10 `/workspace/kanban`).
 *
 * Seven columns (`KANBAN_COLUMNS`), each holding the visible jobs whose
 * category maps to it. Every card carries `allowedColumns`: the columns the
 * CURRENT actor may drop it into, computed with the same graph helpers the
 * drop handler uses (`allowedKanbanColumns` / `resolveKanbanDrop` in
 * src/lib/workflow.ts), so the board never offers a drop the engine rejects.
 *
 * Cancelled jobs are hidden; `includeCancelled` returns them in `cancelled`.
 * Each column returns at most `perColumnLimit` cards (count = full total);
 * the Completed column shows the most recently completed first.
 */
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "@/db/index";
import { clients, jobs } from "@/db/schema";
import { KANBAN_COLUMNS, KANBAN_COLUMN_META, type KanbanColumn } from "@/lib/constants";
import { STAGE_TABS, type Stage } from "@/lib/stages";
import type {
  AuthContext,
  JobPermissionRef,
  JobRow,
  KanbanCard,
  KanbanColumnView,
  SimpleJobRow,
  StageBoard,
  StageBoardCard,
  StageBoardColumn,
  StageBoardMove,
} from "@/lib/types";
import { allowedKanbanColumns, resolveKanbanDrop, type KanbanDropResult } from "@/lib/workflow";
import { loadJobRefs } from "@/server/auth/job-ref";
import { can, isAdmin, workedOnJob } from "@/server/auth/permissions";
import { parseInput } from "@/server/services/_shared";
import { jobFiltersWhere, JobListFiltersSchema, listViewScope, type ListScopeOptions } from "./jobs";
import { viewerRoleFor } from "./jobPageSimple";
import {
  countSimpleRows,
  defaultSimpleOrder,
  doneOrder,
  lateWhere,
  mapSimpleRows,
  selectRawSimpleRows,
  simpleBounds,
  simpleFiltersWhere,
  SimpleJobFiltersSchema,
  stageWhere,
} from "./jobsSimple";
import {
  assertStaffRead,
  categoryIn,
  countJobs,
  loadOrgSettingsRow,
  loadVisibleJob,
  loadWorkflowGraphs,
  mapJobRows,
  orgDayBounds,
  priorityOrderSql,
  selectRawJobs,
  workflowJobOf,
  type RawJobRow,
  type ViewScope,
} from "./scope";

export const KANBAN_DEFAULT_PER_COLUMN = 100;
export const KANBAN_MAX_PER_COLUMN = 500;

export const KanbanQuerySchema = JobListFiltersSchema.extend({
  perColumnLimit: z.preprocess(
    (v) => (Array.isArray(v) ? v[0] : v === "" ? undefined : v),
    z.coerce.number().int().min(1).max(KANBAN_MAX_PER_COLUMN).optional(),
  ),
});
export type KanbanQueryInput = z.input<typeof KanbanQuerySchema>;

export interface KanbanBoard {
  columns: KanbanColumnView[];
  /** Cancelled jobs when `includeCancelled`; otherwise null. */
  cancelled: { cards: KanbanCard[]; count: number } | null;
  /** The resolved view scope (§8; null = no scope switch). */
  scope: ViewScope | null;
  asOf: string;
}

function columnOrder(column: KanbanColumn | "cancelled"): SQL[] {
  if (column === "completed") return [sql`${jobs.completedAt} desc nulls last`, sql`${jobs.id} asc`];
  if (column === "cancelled") return [sql`${jobs.cancelledAt} desc nulls last`, sql`${jobs.id} asc`];
  return [sql`${priorityOrderSql()} desc`, sql`${jobs.dueDate} asc nulls last`, sql`${jobs.statusEnteredAt} asc`, sql`${jobs.id} asc`];
}

/** Adds `allowedColumns` to job rows (one workflow-graph load for all cards). */
export async function toKanbanCards(db: DbLike, ctx: AuthContext, raws: readonly RawJobRow[], now: string): Promise<KanbanCard[]> {
  const rows = await mapJobRows(db, ctx, raws, now);
  const graphs = await loadWorkflowGraphs(
    db,
    ctx,
    raws.map((r) => r.job.workflowId),
  );
  return raws.map((raw, i) => {
    const row: JobRow = rows[i];
    const graph = graphs.get(raw.job.workflowId);
    const allowed = graph ? allowedKanbanColumns(ctx, workflowJobOf(raw.job, raw.editor ? raw.editor.isActive : undefined), graph.statuses, graph.edges) : [];
    return { ...row, allowedColumns: KANBAN_COLUMNS.filter((c) => allowed.includes(c)) };
  });
}

/**
 * The full board for the actor (filters = the All Work vocabulary + perColumnLimit;
 * `?scope=` / `opts.scopeCookie` = the personal / business view, §8).
 */
export async function getKanbanBoard(db: DbLike, ctx: AuthContext, input: unknown = {}, opts: ListScopeOptions = {}): Promise<KanbanBoard> {
  const f = parseInput(KanbanQuerySchema, input ?? {});
  const now = ctx.now();
  const bounds = orgDayBounds(ctx, now, (await loadOrgSettingsRow(db, ctx))?.weekStartsOn ?? 1);
  const viewScope = listViewScope(ctx, f, opts);
  const filterWhere = jobFiltersWhere(ctx, { ...f, includeCancelled: true }, bounds, { defaultHideCancelled: false, viewScope });
  const limit = f.perColumnLimit ?? KANBAN_DEFAULT_PER_COLUMN;

  // Sequential on purpose: `db` may be a transaction (one connection).
  const columns: KanbanColumnView[] = [];
  for (const column of KANBAN_COLUMNS) {
    const meta = KANBAN_COLUMN_META[column];
    const where = and(filterWhere, categoryIn(meta.categories));
    const raws = await selectRawJobs(db, ctx, { where, orderBy: columnOrder(column), limit });
    columns.push({
      column,
      label: meta.label,
      categories: [...meta.categories],
      cards: await toKanbanCards(db, ctx, raws, now),
      count: await countJobs(db, ctx, where),
    });
  }

  let cancelled: KanbanBoard["cancelled"] = null;
  if (f.includeCancelled) {
    const where = and(filterWhere, eq(jobs.statusCategory, "cancelled"));
    const raws = await selectRawJobs(db, ctx, { where, orderBy: columnOrder("cancelled"), limit });
    cancelled = { cards: await toKanbanCards(db, ctx, raws, now), count: await countJobs(db, ctx, where) };
  }
  return { columns, cancelled, scope: viewScope, asOf: now };
}

/**
 * Server-side twin of a drop: what dropping `jobId` on `column` would do for
 * the actor (noop / single target / ambiguous picker / none + reason).
 * 404 when the job is not visible.
 */
export async function previewKanbanDrop(db: DbLike, ctx: AuthContext, jobId: string, column: KanbanColumn): Promise<KanbanDropResult> {
  const { job, ref } = await loadVisibleJob(db, ctx, jobId);
  const raw = (await selectRawJobs(db, ctx, { where: eq(jobs.id, job.id), limit: 1 }))[0];
  const graph = (await loadWorkflowGraphs(db, ctx, [job.workflowId])).get(job.workflowId) ?? { statuses: [], edges: [] };

  return resolveKanbanDrop(ctx, workflowJobOf(job, raw?.editor ? raw.editor.isActive : undefined, ref.pastEditorIds), column, graph.statuses, graph.edges);
}

/* ------------------------------------------------------------------ */
/*  The Board in the five stages (SIMPLIFICATION-PLAN §8 follow-up)     */
/* ------------------------------------------------------------------ */

export const STAGE_BOARD_DEFAULT_PER_COLUMN = 40;
export const STAGE_BOARD_MAX_PER_COLUMN = 500;

/** The Jobs page filters (search / editor / client / late / show cancelled) plus the per-column cap. */
export const StageBoardQuerySchema = SimpleJobFiltersSchema.pick({ q: true, editorId: true, clientId: true, late: true, showCancelled: true }).extend({
  perColumnLimit: z.preprocess(
    (v) => (Array.isArray(v) ? v[0] : v === "" ? undefined : v),
    z.coerce.number().int().min(1).max(STAGE_BOARD_MAX_PER_COLUMN).optional(),
  ),
});
export type StageBoardQueryInput = z.input<typeof StageBoardQuerySchema>;

/** Client ids of the org that use the portal (the Approve share question). */
async function portalClientIds(db: DbLike, ctx: AuthContext, ids: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();
  const rows = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.organisationId, ctx.organisationId), inArray(clients.id, unique), eq(clients.portalEnabled, true)));
  return new Set(rows.map((r) => r.id));
}

/**
 * The drops this viewer may make with a card — one per simple button they would see on the job page
 * (docs/SIMPLIFICATION-PLAN.md §5; the same rules as `getJobPageSimple`, Home and My jobs):
 *
 *   reviewer  Needs editor → With editor (Assign editor) · Ready to check → Done (Approve) /
 *             → Changes asked (Ask for changes) · Done → Changes asked (Reopen)
 *   editor    With editor / Changes asked → Ready to check (Send for checking)
 *
 * Everything else is not a step on the board. The services re-check every rule on the drop itself.
 */
export function stageBoardMoves(ctx: AuthContext, job: Pick<SimpleJobRow, "stage">, ref: JobPermissionRef): StageBoardMove[] {
  const stage = job.stage.stage;
  const viewer = viewerRoleFor(ctx, ref);
  const admin = isAdmin(ctx);
  const moves: StageBoardMove[] = [];
  if (viewer === "reviewer") {
    if (stage === "needs_editor" && can(ctx, "job.assign_editor", ref)) moves.push({ to: "with_editor", action: "assign" });
    // Owners / co-owners may check a job they edited themselves after confirming (§12.3); everyone else follows `job.approve`.
    if (stage === "ready_to_check" && (admin || can(ctx, "job.approve", ref))) {
      moves.push({ to: "done", action: "approve" }, { to: "changes_asked", action: "ask_for_changes" });
    }
    if (stage === "done" && (admin || can(ctx, "job.reopen", ref))) moves.push({ to: "changes_asked", action: "reopen" });
  } else if (viewer === "editor") {
    if (stage === "with_editor" && can(ctx, "job.submit", ref)) moves.push({ to: "ready_to_check", action: "send_for_checking" });
    if (stage === "changes_asked" && can(ctx, "revision.resolve", ref)) moves.push({ to: "ready_to_check", action: "send_for_checking" });
  }
  return moves;
}

function stageOrder(stage: Stage): SQL[] {
  if (stage === "cancelled") return [sql`${jobs.cancelledAt} desc nulls last`, desc(jobs.id)];
  return stage === "done" ? doneOrder() : defaultSimpleOrder();
}

/**
 * The Board drawn in the five stages: one column per `STAGE_TABS` entry (+ Cancelled behind
 * `showCancelled`), every card the shared `SimpleJobRow` plus the viewer's allowed drops.
 * Row scope is `visibleJobsWhere` (A everything; M their shoots; E the jobs given to them);
 * clients never read this (403). Each column returns at most `perColumnLimit` cards; `count`
 * is the full total.
 */
export async function getStageBoard(db: DbLike, ctx: AuthContext, input: unknown = {}): Promise<StageBoard> {
  assertStaffRead(ctx);
  const f = parseInput(StageBoardQuerySchema, input ?? {});
  const bounds = await simpleBounds(db, ctx);
  const limit = f.perColumnLimit ?? STAGE_BOARD_DEFAULT_PER_COLUMN;
  const filterWhere = and(f.late ? lateWhere(bounds) : undefined, simpleFiltersWhere(ctx, f));

  // Sequential on purpose: `db` may be a transaction (one connection).
  const stages: Stage[] = [...STAGE_TABS, ...(f.showCancelled ? (["cancelled"] as const) : [])];
  const loaded: { stage: Stage; rows: SimpleJobRow[]; count: number }[] = [];
  for (const stage of stages) {
    const where = and(stageWhere(stage), filterWhere);
    const rows = await mapSimpleRows(db, ctx, await selectRawSimpleRows(db, ctx, { where, orderBy: stageOrder(stage), limit }), bounds);
    loaded.push({ stage, rows, count: await countSimpleRows(db, ctx, where) });
  }

  const shown = loaded.flatMap((c) => c.rows);
  const refs = await loadJobRefs(
    db,
    ctx,
    shown.map((j) => j.id),
  );
  const portal = await portalClientIds(
    db,
    ctx,
    shown.map((j) => j.client.id),
  );
  const admin = isAdmin(ctx);
  const toCard = (job: SimpleJobRow): StageBoardCard => {
    const ref = refs.get(job.id)?.ref;
    const moves = ref ? stageBoardMoves(ctx, job, ref) : [];
    const checks = moves.some((m) => m.action === "approve");
    return {
      job,
      moves,
      shareQuestion: checks && portal.has(job.client.id),
      selfReviewNeedsConfirm: checks && admin && ref !== undefined && workedOnJob(ctx, ref),
    };
  };
  const columns: StageBoardColumn[] = loaded.map((c) => ({ stage: c.stage, cards: c.rows.map(toCard), count: c.count }));
  return {
    columns: columns.filter((c) => c.stage !== "cancelled"),
    cancelled: columns.find((c) => c.stage === "cancelled") ?? null,
    viewerId: ctx.userId,
    asOf: bounds.now,
  };
}
