/**
 * Workflow admin views (ARCHITECTURE.md §4.6, §10 `/settings/workflows`,
 * `/settings/job-types`): status graph + per-status job counts + validation
 * messages for the editor UI. workflow.view = O/M.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { DbLike } from "@/db/index";
import { jobTypes, jobs, workflowStatuses, workflowTransitions, workflows } from "@/db/schema";
import { CATEGORY_GROUPS } from "@/lib/constants";
import type { AuthContext, JobTypeView, WorkflowGraph, WorkflowListItem, WorkflowTransitionView } from "@/lib/types";
import { generateCancelEdges, toStatusRef, validateWorkflowDefinition, type EdgeLike, type StatusLike } from "@/lib/workflow";
import { assertCan, isManagement } from "@/server/auth/permissions";
import { loadWorkflowInOrg } from "@/server/services/_shared";
import { categoryIn } from "./scope";

function openJobCountsBy(db: DbLike, ctx: AuthContext, column: typeof jobs.workflowId | typeof jobs.jobTypeId): Map<string, number> {
  const rows = db
    .select({ key: column, n: sql<number>`count(*)`.mapWith(Number) })
    .from(jobs)
    .where(and(eq(jobs.organisationId, ctx.organisationId), categoryIn(CATEGORY_GROUPS.ACTIVE)))
    .groupBy(column)
    .all();
  return new Map(rows.map((r) => [r.key, r.n]));
}

function listItems(db: DbLike, ctx: AuthContext, workflowId?: string): WorkflowListItem[] {
  const rows = db
    .select()
    .from(workflows)
    .where(and(eq(workflows.organisationId, ctx.organisationId), workflowId ? eq(workflows.id, workflowId) : undefined))
    .orderBy(sql`${workflows.isDefault} desc`, asc(workflows.name))
    .all();
  const statusCounts = new Map(
    db
      .select({ key: workflowStatuses.workflowId, n: sql<number>`count(*)`.mapWith(Number) })
      .from(workflowStatuses)
      .where(and(eq(workflowStatuses.organisationId, ctx.organisationId), sql`${workflowStatuses.archivedAt} is null`))
      .groupBy(workflowStatuses.workflowId)
      .all()
      .map((r) => [r.key, r.n]),
  );
  const openJobs = openJobCountsBy(db, ctx, jobs.workflowId);
  const types = db
    .select({ id: jobTypes.id, name: jobTypes.name, colour: jobTypes.colour, workflowId: jobTypes.workflowId })
    .from(jobTypes)
    .where(and(eq(jobTypes.organisationId, ctx.organisationId), sql`${jobTypes.archivedAt} is null`))
    .orderBy(asc(jobTypes.sortOrder), asc(jobTypes.name))
    .all();
  return rows.map((w) => ({
    id: w.id,
    name: w.name,
    description: w.description,
    isDefault: w.isDefault,
    archivedAt: w.archivedAt,
    version: w.version,
    statusCount: statusCounts.get(w.id) ?? 0,
    openJobCount: openJobs.get(w.id) ?? 0,
    jobTypes: types.filter((t) => t.workflowId === w.id).map((t) => ({ id: t.id, name: t.name, colour: t.colour })),
  }));
}

/** `GET /api/workflows` (workflow.view). */
export function listWorkflows(db: DbLike, ctx: AuthContext): WorkflowListItem[] {
  assertCan(ctx, "workflow.view");
  return listItems(db, ctx);
}

/**
 * `GET /api/workflows/:id` → statuses (with job counts), stored edges plus
 * the engine-generated cancel edges the workflow lacks, and validation
 * messages. Foreign ids → 404.
 */
export function getWorkflowGraph(db: DbLike, ctx: AuthContext, workflowId: string): WorkflowGraph {
  assertCan(ctx, "workflow.view");
  const workflow = loadWorkflowInOrg(db, ctx, workflowId);
  const statusRows = db
    .select()
    .from(workflowStatuses)
    .where(and(eq(workflowStatuses.organisationId, ctx.organisationId), eq(workflowStatuses.workflowId, workflow.id)))
    .orderBy(asc(workflowStatuses.sortOrder), asc(workflowStatuses.name))
    .all();
  const edgeRows = db
    .select()
    .from(workflowTransitions)
    .where(and(eq(workflowTransitions.organisationId, ctx.organisationId), eq(workflowTransitions.workflowId, workflow.id)))
    .all();
  const jobCounts = new Map(
    db
      .select({ key: jobs.statusId, n: sql<number>`count(*)`.mapWith(Number) })
      .from(jobs)
      .where(and(eq(jobs.organisationId, ctx.organisationId), eq(jobs.workflowId, workflow.id)))
      .groupBy(jobs.statusId)
      .all()
      .map((r) => [r.key, r.n]),
  );

  const statuses: StatusLike[] = statusRows.map((s) => ({
    id: s.id,
    key: s.key,
    name: s.name,
    category: s.category,
    sortOrder: s.sortOrder,
    isInitial: s.isInitial,
    archivedAt: s.archivedAt,
    colour: s.colour,
  }));
  const edges: EdgeLike[] = edgeRows.map((e) => ({
    id: e.id,
    fromStatusId: e.fromStatusId,
    toStatusId: e.toStatusId,
    allowedRoles: e.allowedRoles,
    requiresAssignedEditor: e.requiresAssignedEditor,
    assigneeOnly: e.assigneeOnly,
    isReopen: e.isReopen,
    archivedAt: e.archivedAt,
    label: e.label,
  }));
  const stored = new Set(edges.filter((e) => e.archivedAt === null).map((e) => `${e.fromStatusId}->${e.toStatusId}`));
  const generated = generateCancelEdges(statuses).filter((e) => !stored.has(`${e.fromStatusId}->${e.toStatusId}`));

  const toView = (e: EdgeLike, isGenerated: boolean): WorkflowTransitionView => ({
    id: e.id,
    fromStatusId: e.fromStatusId,
    toStatusId: e.toStatusId,
    label: e.label ?? null,
    allowedRoles: [...e.allowedRoles],
    requiresAssignedEditor: e.requiresAssignedEditor,
    assigneeOnly: e.assigneeOnly,
    isReopen: e.isReopen,
    archivedAt: e.archivedAt,
    generated: isGenerated,
  });

  return {
    workflow: listItems(db, ctx, workflow.id)[0],
    statuses: statusRows.map((s, i) => ({
      ...toStatusRef(statuses[i]),
      isInitial: s.isInitial,
      description: s.description,
      archivedAt: s.archivedAt,
      version: s.version,
      jobCount: jobCounts.get(s.id) ?? 0,
    })),
    transitions: [...edges.map((e) => toView(e, false)), ...generated.map((e) => toView(e, true))],
    validation: validateWorkflowDefinition(statuses, edges),
  };
}

/**
 * `GET /api/job-types` — every authenticated user (the job form needs them);
 * archived types only for management.
 */
export function listJobTypes(db: DbLike, ctx: AuthContext, opts: { includeArchived?: boolean } = {}): JobTypeView[] {
  const withArchived = opts.includeArchived === true && isManagement(ctx);
  const rows = db
    .select({ type: jobTypes, workflow: { id: workflows.id, name: workflows.name } })
    .from(jobTypes)
    .innerJoin(workflows, eq(workflows.id, jobTypes.workflowId))
    .where(and(eq(jobTypes.organisationId, ctx.organisationId), withArchived ? undefined : sql`${jobTypes.archivedAt} is null`))
    .orderBy(asc(jobTypes.sortOrder), asc(jobTypes.name))
    .all();
  const open = openJobCountsBy(db, ctx, jobs.jobTypeId);
  return rows.map(({ type, workflow }) => ({
    id: type.id,
    name: type.name,
    colour: type.colour,
    workflow,
    defaultEstimatedHours: type.defaultEstimatedHours,
    sortOrder: type.sortOrder,
    archivedAt: type.archivedAt,
    version: type.version,
    openJobCount: open.get(type.id) ?? 0,
  }));
}
