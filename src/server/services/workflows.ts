/**
 * Workflow administration (ARCHITECTURE.md §4.6, §2.2, §5 workflow.* /
 * status.* / workflow_transition.*). `workflow.view` = owner / manager,
 * `workflow.manage` = owner. The runtime engine (transitionJobStatus) lives
 * in services/workflow.ts; this module only edits the graph.
 *
 * Validation model
 * - Every mutation returns the graph plus `problems` from
 *   `validateWorkflowDefinition` (src/lib/workflow.ts). A workflow that is not
 *   in use can be saved with problems (a draft).
 * - Binding a job type to a workflow (jobTypes.ts) and making a workflow the
 *   default both require zero problems ("publishing").
 * - A workflow IN USE (bound to a non-archived job type, or holding active
 *   jobs) rejects any edit that introduces a *critical* issue: no/several
 *   initial statuses, a missing required category, or a status that holds
 *   jobs losing its last outgoing (non-cancel) transition.
 * - Hard rules: a status with jobs in it cannot be archived; the initial
 *   status cannot be archived and must stay in category "new"; recategorising
 *   a status with jobs updates `jobs.status_category` in the same tx (status
 *   row first, then jobs — the jobs trigger checks the category against the
 *   status) but may not cross the open/terminal boundary, nor move jobs
 *   without an editor into an editor-required category.
 */
import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { jobTypes, jobs, workflowStatuses, workflowTransitions, workflows } from "@/db/schema";
import {
  CATEGORY_GROUPS,
  DEFAULT_WORKFLOW_STATUSES,
  DEFAULT_WORKFLOW_TRANSITIONS,
  STATUS_CATEGORY_META,
  WORKFLOW_REQUIRED_CATEGORIES,
  type Role,
  type StatusCategory,
} from "@/lib/constants";
import type { AuthContext, Workflow, WorkflowStatus, WorkflowTransition } from "@/lib/types";
import {
  AddStatusInput,
  AddTransitionInput,
  ArchiveStatusInput,
  ArchiveTransitionInput,
  ArchiveWorkflowInput,
  CreateWorkflowInput,
  ReorderStatusesInput,
  UpdateStatusInput,
  UpdateTransitionInput,
  UpdateWorkflowInput,
} from "@/lib/validation/workflow";
import { EDITOR_REQUIRED_CATEGORIES, isEditorWorking, isTerminal, validateWorkflowDefinition } from "@/lib/workflow";
import { recordEvent } from "@/server/audit";
import { assertCan } from "@/server/auth/permissions";
import { NotFoundError } from "@/server/errors";
import { first, loadStatusInWorkflow, loadWorkflowInOrg, one, parseInput, type DbLike, type Tx } from "./_shared";
import { checkVersion, diffFields, ruleViolation, slugify } from "./_admin";

/* ------------------------------------------------------------------ */
/*  Reads                                                              */
/* ------------------------------------------------------------------ */

export interface WorkflowGraph {
  workflow: Workflow;
  /** All statuses (archived included), by sort order. */
  statuses: WorkflowStatus[];
  /** All transitions (archived included). */
  transitions: WorkflowTransition[];
  /** validateWorkflowDefinition() messages; empty = publishable. */
  problems: string[];
  /** Jobs currently sitting in each status (any category). */
  jobCountsByStatus: Record<string, number>;
  /** Non-archived job types bound to this workflow. */
  jobTypeIds: string[];
  inUse: boolean;
}

async function statusesOf(db: DbLike, workflowId: string): Promise<WorkflowStatus[]> {
  return db
    .select()
    .from(workflowStatuses)
    .where(eq(workflowStatuses.workflowId, workflowId))
    .orderBy(asc(workflowStatuses.sortOrder), asc(workflowStatuses.createdAt), asc(workflowStatuses.id));
}

async function transitionsOf(db: DbLike, workflowId: string): Promise<WorkflowTransition[]> {
  return db
    .select()
    .from(workflowTransitions)
    .where(eq(workflowTransitions.workflowId, workflowId))
    .orderBy(asc(workflowTransitions.createdAt), asc(workflowTransitions.id));
}

async function jobCountsByStatus(db: DbLike, ctx: AuthContext, workflowId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ statusId: jobs.statusId, n: count() })
    .from(jobs)
    .where(and(eq(jobs.organisationId, ctx.organisationId), eq(jobs.workflowId, workflowId)))
    .groupBy(jobs.statusId);
  return Object.fromEntries(rows.map((r) => [r.statusId, r.n]));
}

async function boundJobTypeIds(db: DbLike, ctx: AuthContext, workflowId: string): Promise<string[]> {
  const rows = await db
    .select({ id: jobTypes.id })
    .from(jobTypes)
    .where(and(eq(jobTypes.organisationId, ctx.organisationId), eq(jobTypes.workflowId, workflowId), isNull(jobTypes.archivedAt)))
    .orderBy(asc(jobTypes.sortOrder), asc(jobTypes.name), asc(jobTypes.id));
  return rows.map((r) => r.id);
}

async function activeJobCount(db: DbLike, ctx: AuthContext, workflowId: string): Promise<number> {
  const row = await first(
    db
      .select({ n: count() })
      .from(jobs)
      .where(and(eq(jobs.organisationId, ctx.organisationId), eq(jobs.workflowId, workflowId), inArray(jobs.statusCategory, [...CATEGORY_GROUPS.ACTIVE]))),
  );
  return row?.n ?? 0;
}

/** validateWorkflowDefinition over the stored graph. */
export async function workflowProblems(db: DbLike, workflowId: string): Promise<string[]> {
  return validateWorkflowDefinition(await statusesOf(db, workflowId), await transitionsOf(db, workflowId));
}

async function buildGraph(db: DbLike, ctx: AuthContext, workflow: Workflow): Promise<WorkflowGraph> {
  const statuses = await statusesOf(db, workflow.id);
  const transitions = await transitionsOf(db, workflow.id);
  const jobTypeIds = await boundJobTypeIds(db, ctx, workflow.id);
  return {
    workflow,
    statuses,
    transitions,
    problems: validateWorkflowDefinition(statuses, transitions),
    jobCountsByStatus: await jobCountsByStatus(db, ctx, workflow.id),
    jobTypeIds,
    inUse: jobTypeIds.length > 0 || (await activeJobCount(db, ctx, workflow.id)) > 0,
  };
}

/** Statuses, transitions, validation problems and usage of one workflow (owner / manager). */
export async function getWorkflowGraph(db: DbLike, ctx: AuthContext, workflowId: string): Promise<WorkflowGraph> {
  assertCan(ctx, "workflow.view");
  return await buildGraph(db, ctx, await loadWorkflowInOrg(db, ctx, workflowId));
}

/** Validation messages for a stored workflow (owner / manager). */
export async function validateWorkflow(db: DbLike, ctx: AuthContext, workflowId: string): Promise<string[]> {
  assertCan(ctx, "workflow.view");
  await loadWorkflowInOrg(db, ctx, workflowId);
  return await workflowProblems(db, workflowId);
}

/* ------------------------------------------------------------------ */
/*  Guards                                                             */
/* ------------------------------------------------------------------ */

/**
 * Issues that would break jobs already using the workflow. Deliberately
 * narrower than validateWorkflowDefinition so admins can add a status and
 * then wire its transitions in separate steps.
 */
async function criticalIssues(db: DbLike, ctx: AuthContext, workflowId: string): Promise<string[]> {
  const statuses = (await statusesOf(db, workflowId)).filter((s) => s.archivedAt === null);
  const edges = (await transitionsOf(db, workflowId)).filter((e) => e.archivedAt === null);
  const issues: string[] = [];
  const initials = statuses.filter((s) => s.isInitial);
  if (initials.length !== 1 || initials[0].category !== "new") issues.push('The workflow needs exactly one initial status in category "new"');
  for (const c of WORKFLOW_REQUIRED_CATEGORIES) {
    if (!statuses.some((s) => s.category === c)) issues.push(`The workflow needs a status in category "${c}"`);
  }
  const byId = new Map(statuses.map((s) => [s.id, s]));
  const counts = await jobCountsByStatus(db, ctx, workflowId);
  for (const s of statuses) {
    if (isTerminal(s.category) || (counts[s.id] ?? 0) === 0) continue;
    const hasExit = edges.some((e) => e.fromStatusId === s.id && byId.has(e.toStatusId) && byId.get(e.toStatusId)?.category !== "cancelled");
    if (!hasExit) issues.push(`Status "${s.name}" holds jobs and would have no way out`);
  }
  return issues;
}

async function isInUse(db: DbLike, ctx: AuthContext, workflowId: string): Promise<boolean> {
  return (await boundJobTypeIds(db, ctx, workflowId)).length > 0 || (await activeJobCount(db, ctx, workflowId)) > 0;
}

/** Rejects (rolls back) an edit that introduced a critical issue in an in-use workflow. */
async function assertNoNewCriticalIssues(db: DbLike, ctx: AuthContext, workflowId: string, before: readonly string[]): Promise<void> {
  if (!(await isInUse(db, ctx, workflowId))) return;
  const introduced = (await criticalIssues(db, ctx, workflowId)).filter((i) => !before.includes(i));
  if (introduced.length > 0) {
    throw ruleViolation(`This change would break a workflow that is in use: ${introduced.join("; ")}`, { problems: introduced });
  }
}

async function loadEditableWorkflow(db: DbLike, ctx: AuthContext, workflowId: string): Promise<Workflow> {
  const wf = await loadWorkflowInOrg(db, ctx, workflowId);
  if (wf.archivedAt) throw ruleViolation("This workflow is archived");
  return wf;
}

async function loadStatusInOrg(db: DbLike, ctx: AuthContext, statusId: string): Promise<WorkflowStatus> {
  const row = await first(
    db
      .select()
      .from(workflowStatuses)
      .where(and(eq(workflowStatuses.id, statusId), eq(workflowStatuses.organisationId, ctx.organisationId))),
  );
  if (!row) throw new NotFoundError("Status");
  return row;
}

export async function loadTransitionInOrg(db: DbLike, ctx: AuthContext, transitionId: string): Promise<WorkflowTransition> {
  const row = await first(
    db
      .select()
      .from(workflowTransitions)
      .where(and(eq(workflowTransitions.id, transitionId), eq(workflowTransitions.organisationId, ctx.organisationId))),
  );
  if (!row) throw new NotFoundError("Transition");
  return row;
}

async function assertWorkflowNameFree(db: DbLike, ctx: AuthContext, name: string, exceptId?: string): Promise<void> {
  const rows = await db.select({ id: workflows.id, name: workflows.name }).from(workflows).where(eq(workflows.organisationId, ctx.organisationId));
  const clash = rows.find((w) => w.name.trim().toLowerCase() === name.trim().toLowerCase() && w.id !== exceptId);
  if (clash) throw ruleViolation("A workflow with this name already exists", {}, "name");
}

function assertStatusNameFree(statuses: readonly WorkflowStatus[], name: string, exceptId?: string): void {
  const clash = statuses.find((s) => s.archivedAt === null && s.id !== exceptId && s.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (clash) throw ruleViolation(`A status named "${clash.name}" already exists in this workflow`, {}, "name");
}

/* ------------------------------------------------------------------ */
/*  Workflows                                                          */
/* ------------------------------------------------------------------ */

interface StatusSeed {
  key: string;
  name: string;
  category: StatusCategory;
  colour: string;
  sortOrder: number;
  isInitial: boolean;
  description?: string | null;
}

interface EdgeSeed {
  from: string;
  to: string;
  label: string | null;
  allowedRoles: Role[];
  requiresAssignedEditor: boolean;
  assigneeOnly: boolean;
  isReopen: boolean;
}

const OMP: Role[] = ["owner", "manager", "photographer"];

function defaultTemplate(): { statuses: StatusSeed[]; edges: EdgeSeed[] } {
  const statuses = DEFAULT_WORKFLOW_STATUSES.map((s) => ({ ...s }));
  const edges: EdgeSeed[] = [
    ...DEFAULT_WORKFLOW_TRANSITIONS.map((t) => ({
      from: t.from,
      to: t.to,
      label: t.label,
      allowedRoles: [...t.allowedRoles],
      requiresAssignedEditor: t.requiresAssignedEditor ?? false,
      assigneeOnly: t.assigneeOnly ?? false,
      isReopen: t.isReopen ?? false,
    })),
    // Explicit → cancelled edge for every open status (same as the seed / test fixture).
    ...DEFAULT_WORKFLOW_STATUSES.filter((s) => STATUS_CATEGORY_META[s.category].open).map((s) => ({
      from: s.key,
      to: "cancelled",
      label: "Cancel",
      allowedRoles: OMP,
      requiresAssignedEditor: false,
      assigneeOnly: false,
      isReopen: false,
    })),
  ];
  return { statuses, edges };
}

function blankTemplate(): { statuses: StatusSeed[]; edges: EdgeSeed[] } {
  const statuses = DEFAULT_WORKFLOW_STATUSES.filter((s) => WORKFLOW_REQUIRED_CATEGORIES.includes(s.category)).map((s, i) => ({
    ...s,
    sortOrder: i,
  }));
  return { statuses, edges: [] };
}

async function copyTemplate(db: DbLike, ctx: AuthContext, sourceWorkflowId: string): Promise<{ statuses: StatusSeed[]; edges: EdgeSeed[] }> {
  await loadWorkflowInOrg(db, ctx, sourceWorkflowId);
  const statuses = (await statusesOf(db, sourceWorkflowId)).filter((s) => s.archivedAt === null);
  const keyById = new Map(statuses.map((s) => [s.id, s.key]));
  const edges = (await transitionsOf(db, sourceWorkflowId))
    .filter((e) => e.archivedAt === null && keyById.has(e.fromStatusId) && keyById.has(e.toStatusId))
    .map((e) => ({
      from: keyById.get(e.fromStatusId) as string,
      to: keyById.get(e.toStatusId) as string,
      label: e.label,
      allowedRoles: [...e.allowedRoles],
      requiresAssignedEditor: e.requiresAssignedEditor,
      assigneeOnly: e.assigneeOnly,
      isReopen: e.isReopen,
    }));
  return {
    statuses: statuses.map((s) => ({
      key: s.key,
      name: s.name,
      category: s.category,
      colour: s.colour,
      sortOrder: s.sortOrder,
      isInitial: s.isInitial,
      description: s.description,
    })),
    edges,
  };
}

/** Makes `wf` the organisation default (unsets the previous one first: partial unique index). */
async function makeDefault(tx: Tx, ctx: AuthContext, wf: Workflow): Promise<Workflow> {
  if (wf.archivedAt) throw ruleViolation("An archived workflow cannot be the default");
  const problems = await workflowProblems(tx, wf.id);
  if (problems.length > 0) throw ruleViolation("Fix the workflow's problems before making it the default", { problems });
  const now = ctx.now();
  const previous = (
    await tx
      .select()
      .from(workflows)
      .where(and(eq(workflows.organisationId, ctx.organisationId), eq(workflows.isDefault, true), isNull(workflows.archivedAt)))
      .orderBy(asc(workflows.id))
  ).filter((w) => w.id !== wf.id);
  for (const old of previous) {
    await tx
      .update(workflows)
      .set({ isDefault: false, updatedAt: now, version: old.version + 1 })
      .where(eq(workflows.id, old.id));
    await recordEvent(tx, ctx, {
      entityType: "workflow",
      entityId: old.id,
      eventType: "workflow.updated",
      action: "updated",
      previousValue: { isDefault: true },
      newValue: { isDefault: false },
      metadata: { workflowId: old.id, name: old.name },
    });
  }
  return one(
    tx
      .update(workflows)
      .set({ isDefault: true, updatedAt: now, version: wf.version + 1 })
      .where(eq(workflows.id, wf.id))
      .returning(),
  );
}

/** Owner only. `from`: "default" template, copy of another "workflow", or "blank" (required statuses, no transitions). */
export async function createWorkflow(tx: Tx, ctx: AuthContext, input: unknown): Promise<WorkflowGraph> {
  assertCan(ctx, "workflow.manage");
  const data = parseInput(CreateWorkflowInput, input);
  await assertWorkflowNameFree(tx, ctx, data.name);
  const template =
    data.from === "workflow" ? await copyTemplate(tx, ctx, data.sourceWorkflowId as string) : data.from === "blank" ? blankTemplate() : defaultTemplate();

  const now = ctx.now();
  let wf = await one(
    tx
      .insert(workflows)
      .values({
        organisationId: ctx.organisationId,
        name: data.name,
        description: data.description ?? null,
        isDefault: false,
        createdByUserId: ctx.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning(),
  );

  const idByKey = new Map<string, string>();
  for (const s of template.statuses) {
    const row = await one(
      tx
        .insert(workflowStatuses)
        .values({
          organisationId: ctx.organisationId,
          workflowId: wf.id,
          key: s.key,
          name: s.name,
          category: s.category,
          colour: s.colour,
          sortOrder: s.sortOrder,
          isInitial: s.isInitial,
          description: s.description ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: workflowStatuses.id }),
    );
    idByKey.set(s.key, row.id);
  }
  for (const e of template.edges) {
    await tx.insert(workflowTransitions).values({
      organisationId: ctx.organisationId,
      workflowId: wf.id,
      fromStatusId: idByKey.get(e.from) as string,
      toStatusId: idByKey.get(e.to) as string,
      label: e.label,
      allowedRoles: e.allowedRoles,
      requiresAssignedEditor: e.requiresAssignedEditor,
      assigneeOnly: e.assigneeOnly,
      isReopen: e.isReopen,
      createdAt: now,
      updatedAt: now,
    });
  }
  await recordEvent(tx, ctx, {
    entityType: "workflow",
    entityId: wf.id,
    eventType: "workflow.created",
    action: "created",
    previousValue: null,
    newValue: {
      name: wf.name,
      description: wf.description,
      from: data.from,
      sourceWorkflowId: data.sourceWorkflowId ?? null,
      statusKeys: template.statuses.map((s) => s.key),
      transitionCount: template.edges.length,
      isDefault: data.isDefault ?? false,
    },
    metadata: { workflowId: wf.id },
  });
  if (data.isDefault) wf = await makeDefault(tx, ctx, wf);
  return await buildGraph(tx, ctx, wf);
}

export async function updateWorkflow(tx: Tx, ctx: AuthContext, input: unknown): Promise<WorkflowGraph> {
  assertCan(ctx, "workflow.manage");
  const data = parseInput(UpdateWorkflowInput, input);
  let wf = await loadEditableWorkflow(tx, ctx, data.workflowId);
  checkVersion(wf, data.expectedVersion, wf);
  if (data.name !== undefined) await assertWorkflowNameFree(tx, ctx, data.name, wf.id);
  const diff = diffFields(wf, data, ["name", "description"] as const);
  if (diff.changed.length > 0) {
    wf = await one(
      tx
        .update(workflows)
        .set({ ...diff.set, updatedAt: ctx.now(), version: wf.version + 1 })
        .where(eq(workflows.id, wf.id))
        .returning(),
    );
    await recordEvent(tx, ctx, {
      entityType: "workflow",
      entityId: wf.id,
      eventType: "workflow.updated",
      action: "updated",
      previousValue: diff.previous,
      newValue: diff.next,
      metadata: { workflowId: wf.id, name: wf.name },
    });
  }
  if (data.isDefault && !wf.isDefault) {
    wf = await makeDefault(tx, ctx, wf);
    await recordEvent(tx, ctx, {
      entityType: "workflow",
      entityId: wf.id,
      eventType: "workflow.updated",
      action: "updated",
      previousValue: { isDefault: false },
      newValue: { isDefault: true },
      metadata: { workflowId: wf.id, name: wf.name },
    });
  }
  return await buildGraph(tx, ctx, wf);
}

/** Blocked for the default workflow, while non-archived job types are bound, or while active jobs use it. */
export async function archiveWorkflow(tx: Tx, ctx: AuthContext, input: unknown): Promise<Workflow> {
  assertCan(ctx, "workflow.manage");
  const data = parseInput(ArchiveWorkflowInput, input);
  const wf = await loadEditableWorkflow(tx, ctx, data.workflowId);
  checkVersion(wf, data.expectedVersion, wf);
  if (wf.isDefault) throw ruleViolation("The default workflow cannot be archived. Make another workflow the default first.");
  const bound = await boundJobTypeIds(tx, ctx, wf.id);
  if (bound.length > 0) {
    throw ruleViolation(`${bound.length} job type(s) use this workflow. Move them to another workflow first.`, { jobTypeIds: bound });
  }
  const active = await activeJobCount(tx, ctx, wf.id);
  if (active > 0) throw ruleViolation(`${active} active job(s) use this workflow. Complete, cancel or migrate them first.`, { activeJobCount: active });
  const now = ctx.now();
  const row = await one(
    tx
      .update(workflows)
      .set({ archivedAt: now, updatedAt: now, version: wf.version + 1 })
      .where(eq(workflows.id, wf.id))
      .returning(),
  );
  await recordEvent(tx, ctx, {
    entityType: "workflow",
    entityId: wf.id,
    eventType: "workflow.archived",
    action: "archived",
    previousValue: { archivedAt: null },
    newValue: { archivedAt: now },
    metadata: { workflowId: wf.id, name: wf.name },
  });
  return row;
}

/* ------------------------------------------------------------------ */
/*  Statuses                                                           */
/* ------------------------------------------------------------------ */

function uniqueKey(statuses: readonly WorkflowStatus[], base: string): string {
  const taken = new Set(statuses.map((s) => s.key));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}_${i}`.slice(0, 64);
    if (!taken.has(candidate)) return candidate;
  }
}

function statusSnapshot(s: WorkflowStatus) {
  return { name: s.name, key: s.key, category: s.category, colour: s.colour, sortOrder: s.sortOrder, isInitial: s.isInitial };
}

/** Clears `is_initial` on the current initial status (before another one takes over). */
async function clearInitial(tx: Tx, ctx: AuthContext, statuses: readonly WorkflowStatus[], exceptId?: string): Promise<void> {
  for (const s of statuses) {
    if (s.isInitial && s.archivedAt === null && s.id !== exceptId) {
      await tx
        .update(workflowStatuses)
        .set({ isInitial: false, updatedAt: ctx.now(), version: s.version + 1 })
        .where(eq(workflowStatuses.id, s.id));
    }
  }
}

export async function addStatus(tx: Tx, ctx: AuthContext, input: unknown): Promise<{ status: WorkflowStatus; graph: WorkflowGraph }> {
  assertCan(ctx, "workflow.manage");
  const data = parseInput(AddStatusInput, input);
  const wf = await loadEditableWorkflow(tx, ctx, data.workflowId);
  const before = await criticalIssues(tx, ctx, wf.id);
  const statuses = await statusesOf(tx, wf.id);
  assertStatusNameFree(statuses, data.name);
  if (data.key && statuses.some((s) => s.key === data.key)) throw ruleViolation(`Key "${data.key}" is already used in this workflow`, {}, "key");
  const key = data.key ?? uniqueKey(statuses, slugify(data.name));
  if (data.isInitial && data.category !== "new") throw ruleViolation('The initial status must be in category "new"', {}, "isInitial");
  if (data.isInitial) await clearInitial(tx, ctx, statuses);
  const live = statuses.filter((s) => s.archivedAt === null);
  const sortOrder = data.sortOrder ?? (live.length ? Math.max(...live.map((s) => s.sortOrder)) + 1 : 0);
  const now = ctx.now();
  const status = await one(
    tx
      .insert(workflowStatuses)
      .values({
        organisationId: ctx.organisationId,
        workflowId: wf.id,
        key,
        name: data.name,
        category: data.category,
        colour: data.colour ?? STATUS_CATEGORY_META[data.category].hex,
        sortOrder,
        isInitial: data.isInitial ?? false,
        description: data.description ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning(),
  );
  await recordEvent(tx, ctx, {
    entityType: "status",
    entityId: status.id,
    eventType: "status.created",
    action: "created",
    previousValue: null,
    newValue: statusSnapshot(status),
    metadata: { workflowId: wf.id, statusId: status.id },
  });
  await assertNoNewCriticalIssues(tx, ctx, wf.id, before);
  return { status, graph: await buildGraph(tx, ctx, wf) };
}

export interface UpdateStatusResult {
  status: WorkflowStatus;
  /** Jobs whose status_category was rewritten by a recategorisation. */
  affectedJobIds: string[];
  graph: WorkflowGraph;
}

export async function updateStatus(tx: Tx, ctx: AuthContext, input: unknown): Promise<UpdateStatusResult> {
  assertCan(ctx, "workflow.manage");
  const data = parseInput(UpdateStatusInput, input);
  const status = await loadStatusInOrg(tx, ctx, data.statusId);
  const wf = await loadEditableWorkflow(tx, ctx, status.workflowId);
  if (status.archivedAt) throw ruleViolation("This status is archived");
  checkVersion(status, data.expectedVersion, status);
  const before = await criticalIssues(tx, ctx, wf.id);
  const statuses = await statusesOf(tx, wf.id);
  if (data.name !== undefined) assertStatusNameFree(statuses, data.name, status.id);

  const nextCategory = data.category ?? status.category;
  if ((status.isInitial || data.isInitial) && nextCategory !== "new") {
    throw ruleViolation('The initial status must be in category "new"', {}, data.category ? "category" : "isInitial");
  }

  const diff = diffFields(status, data, ["name", "category", "colour", "description", "isInitial"] as const);
  if (diff.changed.length === 0) return { status, affectedJobIds: [], graph: await buildGraph(tx, ctx, wf) };

  // Jobs sitting in this status (recategorisation rules).
  const jobsHere = await tx
    .select({ id: jobs.id, editorId: jobs.editorId, isPaused: jobs.isPaused })
    .from(jobs)
    .where(and(eq(jobs.organisationId, ctx.organisationId), eq(jobs.statusId, status.id)))
    .orderBy(asc(jobs.jobNumber), asc(jobs.id));
  const recategorised = diff.changed.includes("category");
  if (recategorised && jobsHere.length > 0) {
    if (isTerminal(status.category) !== isTerminal(nextCategory)) {
      throw ruleViolation(
        `${jobsHere.length} job(s) are in "${status.name}"; a status holding jobs cannot move between open and closed categories. Move the jobs first.`,
        { jobCount: jobsHere.length },
        "category",
      );
    }
    if (EDITOR_REQUIRED_CATEGORIES.includes(nextCategory) && jobsHere.some((j) => j.editorId === null)) {
      throw ruleViolation(`Some jobs in "${status.name}" have no editor; category "${nextCategory}" requires one.`, {}, "category");
    }
  }

  if (data.isInitial) await clearInitial(tx, ctx, statuses, status.id);
  const now = ctx.now();
  const row = await one(
    tx
      .update(workflowStatuses)
      .set({ ...diff.set, updatedAt: now, version: status.version + 1 })
      .where(eq(workflowStatuses.id, status.id))
      .returning(),
  );

  let affectedJobIds: string[] = [];
  if (recategorised && jobsHere.length > 0) {
    // Status row first (above), then jobs: the jobs trigger checks category == status.category.
    affectedJobIds = jobsHere.map((j) => j.id);
    const clearPause = !isEditorWorking(nextCategory);
    await tx
      .update(jobs)
      .set({
        statusCategory: nextCategory,
        ...(clearPause ? { isPaused: false, pausedAt: null } : {}),
        updatedAt: now,
        version: sql`${jobs.version} + 1`,
      })
      .where(and(eq(jobs.organisationId, ctx.organisationId), eq(jobs.statusId, status.id)));
  }

  await recordEvent(tx, ctx, {
    entityType: "status",
    entityId: status.id,
    eventType: "status.updated",
    action: "updated",
    previousValue: diff.previous,
    newValue: diff.next,
    metadata: {
      workflowId: wf.id,
      statusId: status.id,
      name: row.name,
      ...(recategorised ? { affectedJobCount: affectedJobIds.length, affectedJobIds: affectedJobIds.slice(0, 500) } : {}),
    },
  });
  await assertNoNewCriticalIssues(tx, ctx, wf.id, before);
  return { status: row, affectedJobIds, graph: await buildGraph(tx, ctx, wf) };
}

/** Blocked while any job sits in the status, and for the initial status. Its transitions are archived with it. */
export async function archiveStatus(tx: Tx, ctx: AuthContext, input: unknown): Promise<{ status: WorkflowStatus; graph: WorkflowGraph }> {
  assertCan(ctx, "workflow.manage");
  const data = parseInput(ArchiveStatusInput, input);
  const status = await loadStatusInOrg(tx, ctx, data.statusId);
  const wf = await loadEditableWorkflow(tx, ctx, status.workflowId);
  if (status.archivedAt) throw ruleViolation("This status is already archived");
  checkVersion(status, data.expectedVersion, status);
  if (status.isInitial) throw ruleViolation("The initial status cannot be archived. Make another status initial first.");
  const n =
    (
      await first(
        tx
          .select({ n: count() })
          .from(jobs)
          .where(and(eq(jobs.organisationId, ctx.organisationId), eq(jobs.statusId, status.id))),
      )
    )?.n ?? 0;
  if (n > 0) throw ruleViolation(`${n} job(s) are in "${status.name}". Move them to another status first.`, { jobCount: n });

  const before = await criticalIssues(tx, ctx, wf.id);
  const now = ctx.now();
  const edges = (await transitionsOf(tx, wf.id)).filter((e) => e.archivedAt === null && (e.fromStatusId === status.id || e.toStatusId === status.id));
  for (const e of edges) {
    await tx.update(workflowTransitions).set({ archivedAt: now, updatedAt: now }).where(eq(workflowTransitions.id, e.id));
  }
  const row = await one(
    tx
      .update(workflowStatuses)
      .set({ archivedAt: now, updatedAt: now, version: status.version + 1 })
      .where(eq(workflowStatuses.id, status.id))
      .returning(),
  );
  await recordEvent(tx, ctx, {
    entityType: "status",
    entityId: status.id,
    eventType: "status.archived",
    action: "archived",
    previousValue: { archivedAt: null, name: status.name },
    newValue: { archivedAt: now, name: status.name },
    metadata: { workflowId: wf.id, statusId: status.id, archivedTransitionIds: edges.map((e) => e.id) },
  });
  await assertNoNewCriticalIssues(tx, ctx, wf.id, before);
  return { status: row, graph: await buildGraph(tx, ctx, wf) };
}

/** `statusIds` must list every non-archived status of the workflow exactly once. */
export async function reorderStatuses(tx: Tx, ctx: AuthContext, input: unknown): Promise<WorkflowGraph> {
  assertCan(ctx, "workflow.manage");
  const data = parseInput(ReorderStatusesInput, input);
  const wf = await loadEditableWorkflow(tx, ctx, data.workflowId);
  const live = (await statusesOf(tx, wf.id)).filter((s) => s.archivedAt === null);
  const liveIds = new Set(live.map((s) => s.id));
  const unique = new Set(data.statusIds);
  if (unique.size !== data.statusIds.length || unique.size !== liveIds.size || data.statusIds.some((id) => !liveIds.has(id))) {
    throw ruleViolation("List every active status of this workflow exactly once", {}, "statusIds");
  }
  const previousOrder = live.map((s) => s.id);
  const now = ctx.now();
  const byId = new Map(live.map((s) => [s.id, s]));
  for (const [index, id] of data.statusIds.entries()) {
    const s = byId.get(id) as WorkflowStatus;
    if (s.sortOrder !== index) {
      await tx
        .update(workflowStatuses)
        .set({ sortOrder: index, updatedAt: now, version: s.version + 1 })
        .where(eq(workflowStatuses.id, id));
    }
  }
  await recordEvent(tx, ctx, {
    entityType: "workflow",
    entityId: wf.id,
    eventType: "status.reordered",
    action: "updated",
    previousValue: { order: previousOrder },
    newValue: { order: data.statusIds },
    metadata: { workflowId: wf.id, name: wf.name },
  });
  return await buildGraph(tx, ctx, wf);
}

/* ------------------------------------------------------------------ */
/*  Transitions                                                        */
/* ------------------------------------------------------------------ */

function edgeSnapshot(e: WorkflowTransition, names: Map<string, string>) {
  return {
    fromStatusId: e.fromStatusId,
    toStatusId: e.toStatusId,
    fromStatusName: names.get(e.fromStatusId) ?? null,
    toStatusName: names.get(e.toStatusId) ?? null,
    label: e.label,
    allowedRoles: e.allowedRoles,
    requiresAssignedEditor: e.requiresAssignedEditor,
    assigneeOnly: e.assigneeOnly,
    isReopen: e.isReopen,
  };
}

async function statusNames(db: DbLike, workflowId: string): Promise<Map<string, string>> {
  return new Map((await statusesOf(db, workflowId)).map((s) => [s.id, s.name]));
}

/** Adds an edge (re-activates an archived edge for the same pair: the pair is unique). */
export async function addTransition(tx: Tx, ctx: AuthContext, input: unknown): Promise<{ transition: WorkflowTransition; graph: WorkflowGraph }> {
  assertCan(ctx, "workflow.manage");
  const data = parseInput(AddTransitionInput, input);
  const wf = await loadEditableWorkflow(tx, ctx, data.workflowId);
  const from = await loadStatusInWorkflow(tx, ctx, wf.id, data.fromStatusId);
  const to = await loadStatusInWorkflow(tx, ctx, wf.id, data.toStatusId);
  if (from.archivedAt || to.archivedAt) throw ruleViolation("Both statuses must be active");
  const before = await criticalIssues(tx, ctx, wf.id);
  const existing = await first(
    tx
      .select()
      .from(workflowTransitions)
      .where(and(eq(workflowTransitions.fromStatusId, from.id), eq(workflowTransitions.toStatusId, to.id))),
  );
  if (existing && existing.archivedAt === null) throw ruleViolation(`"${from.name}" → "${to.name}" already exists`);
  const now = ctx.now();
  const values = {
    label: data.label ?? null,
    allowedRoles: data.allowedRoles,
    requiresAssignedEditor: data.requiresAssignedEditor ?? false,
    assigneeOnly: data.assigneeOnly ?? false,
    isReopen: data.isReopen ?? false,
    updatedAt: now,
  };
  const transition = existing
    ? await one(
        tx
          .update(workflowTransitions)
          .set({ ...values, archivedAt: null })
          .where(eq(workflowTransitions.id, existing.id))
          .returning(),
      )
    : await one(
        tx
          .insert(workflowTransitions)
          .values({ ...values, organisationId: ctx.organisationId, workflowId: wf.id, fromStatusId: from.id, toStatusId: to.id, createdAt: now })
          .returning(),
      );
  await recordEvent(tx, ctx, {
    entityType: "workflow_transition",
    entityId: transition.id,
    eventType: "workflow_transition.created",
    action: "created",
    previousValue: null,
    newValue: edgeSnapshot(transition, await statusNames(tx, wf.id)),
    metadata: { workflowId: wf.id, transitionId: transition.id, revived: !!existing },
  });
  await assertNoNewCriticalIssues(tx, ctx, wf.id, before);
  return { transition, graph: await buildGraph(tx, ctx, wf) };
}

export async function updateTransition(tx: Tx, ctx: AuthContext, input: unknown): Promise<{ transition: WorkflowTransition; graph: WorkflowGraph }> {
  assertCan(ctx, "workflow.manage");
  const data = parseInput(UpdateTransitionInput, input);
  const edge = await loadTransitionInOrg(tx, ctx, data.transitionId);
  const wf = await loadEditableWorkflow(tx, ctx, edge.workflowId);
  if (edge.archivedAt) throw ruleViolation("This transition is archived");
  const diff = diffFields(edge, data, ["label", "requiresAssignedEditor", "assigneeOnly", "isReopen"] as const);
  const rolesChanged = data.allowedRoles !== undefined && JSON.stringify([...data.allowedRoles].sort()) !== JSON.stringify([...edge.allowedRoles].sort());
  if (rolesChanged) {
    diff.previous.allowedRoles = edge.allowedRoles;
    diff.next.allowedRoles = data.allowedRoles;
  }
  if (diff.changed.length === 0 && !rolesChanged) return { transition: edge, graph: await buildGraph(tx, ctx, wf) };
  const transition = await one(
    tx
      .update(workflowTransitions)
      .set({ ...diff.set, ...(rolesChanged ? { allowedRoles: data.allowedRoles } : {}), updatedAt: ctx.now() })
      .where(eq(workflowTransitions.id, edge.id))
      .returning(),
  );
  const names = await statusNames(tx, wf.id);
  await recordEvent(tx, ctx, {
    entityType: "workflow_transition",
    entityId: edge.id,
    eventType: "workflow_transition.updated",
    action: "updated",
    previousValue: { ...diff.previous, fromStatusName: names.get(edge.fromStatusId), toStatusName: names.get(edge.toStatusId) },
    newValue: { ...diff.next, fromStatusName: names.get(edge.fromStatusId), toStatusName: names.get(edge.toStatusId) },
    metadata: { workflowId: wf.id, transitionId: edge.id },
  });
  return { transition, graph: await buildGraph(tx, ctx, wf) };
}

export async function archiveTransition(tx: Tx, ctx: AuthContext, input: unknown): Promise<{ transition: WorkflowTransition; graph: WorkflowGraph }> {
  assertCan(ctx, "workflow.manage");
  const data = parseInput(ArchiveTransitionInput, input);
  const edge = await loadTransitionInOrg(tx, ctx, data.transitionId);
  const wf = await loadEditableWorkflow(tx, ctx, edge.workflowId);
  if (edge.archivedAt) throw ruleViolation("This transition is already archived");
  const before = await criticalIssues(tx, ctx, wf.id);
  const now = ctx.now();
  const transition = await one(tx.update(workflowTransitions).set({ archivedAt: now, updatedAt: now }).where(eq(workflowTransitions.id, edge.id)).returning());
  await recordEvent(tx, ctx, {
    entityType: "workflow_transition",
    entityId: edge.id,
    eventType: "workflow_transition.archived",
    action: "archived",
    previousValue: edgeSnapshot(edge, await statusNames(tx, wf.id)),
    newValue: { archivedAt: now },
    metadata: { workflowId: wf.id, transitionId: edge.id },
  });
  await assertNoNewCriticalIssues(tx, ctx, wf.id, before);
  return { transition, graph: await buildGraph(tx, ctx, wf) };
}
