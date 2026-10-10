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
import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "@/db/index";
import { jobs } from "@/db/schema";
import { KANBAN_COLUMNS, KANBAN_COLUMN_META, type KanbanColumn } from "@/lib/constants";
import type { AuthContext, JobRow, KanbanCard, KanbanColumnView } from "@/lib/types";
import { allowedKanbanColumns, resolveKanbanDrop, type KanbanDropResult } from "@/lib/workflow";
import { parseInput } from "@/server/services/_shared";
import { jobFiltersWhere, JobListFiltersSchema } from "./jobs";
import {
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

/** The full board for the actor (filters = the All Work vocabulary + perColumnLimit). */
export async function getKanbanBoard(db: DbLike, ctx: AuthContext, input: unknown = {}): Promise<KanbanBoard> {
  const f = parseInput(KanbanQuerySchema, input ?? {});
  const now = ctx.now();
  const bounds = orgDayBounds(ctx, now, (await loadOrgSettingsRow(db, ctx))?.weekStartsOn ?? 1);
  const filterWhere = jobFiltersWhere(ctx, { ...f, includeCancelled: true }, bounds, { defaultHideCancelled: false });
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
  return { columns, cancelled, asOf: now };
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
