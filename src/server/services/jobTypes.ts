/**
 * Job types service (ARCHITECTURE.md §2.2, §4.6, §5 job_type.*).
 * `job_type.manage` = owner / manager. Each type is bound to a workflow; the
 * binding only affects NEW jobs (jobs.workflow_id is a snapshot). Binding
 * requires a non-archived workflow with zero validation problems.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { jobTypes, workflows } from "@/db/schema";
import type { AuthContext, JobType, Workflow } from "@/lib/types";
import { CreateJobTypeInput, JobTypeIdInput, UpdateJobTypeInput } from "@/lib/validation/workflow";
import { recordEvent } from "@/server/audit";
import { assertCan } from "@/server/auth/permissions";
import { first, loadJobTypeInOrg, loadWorkflowInOrg, one, parseInput, type DbLike, type Tx } from "./_shared";
import { checkVersion, diffFields, ruleViolation } from "./_admin";
import { workflowProblems } from "./workflows";

const EDITABLE = ["name", "colour", "workflowId", "defaultEstimatedHours", "sortOrder"] as const;

/** The organisation's default (non-archived) workflow. */
export async function defaultWorkflowOf(db: DbLike, ctx: AuthContext): Promise<Workflow> {
  const wf = await first(
    db
      .select()
      .from(workflows)
      .where(and(eq(workflows.organisationId, ctx.organisationId), eq(workflows.isDefault, true), isNull(workflows.archivedAt)))
      .limit(1),
  );
  if (!wf) throw ruleViolation("The organisation has no default workflow");
  return wf;
}

/** A workflow a job type may be bound to: in-org (404), not archived, no validation problems. */
export async function assertBindableWorkflow(db: DbLike, ctx: AuthContext, workflowId: string): Promise<Workflow> {
  const wf = await loadWorkflowInOrg(db, ctx, workflowId);
  if (wf.archivedAt) throw ruleViolation("That workflow is archived", {}, "workflowId");
  const problems = await workflowProblems(db, wf.id);
  if (problems.length > 0) throw ruleViolation(`Workflow "${wf.name}" has problems; fix them before using it`, { problems }, "workflowId");
  return wf;
}

async function assertNameFree(db: DbLike, ctx: AuthContext, name: string, exceptId?: string): Promise<void> {
  const rows = await db.select({ id: jobTypes.id, name: jobTypes.name }).from(jobTypes).where(eq(jobTypes.organisationId, ctx.organisationId));
  const clash = rows.find((t) => t.name.trim().toLowerCase() === name.trim().toLowerCase() && t.id !== exceptId);
  if (clash) throw ruleViolation("A job type with this name already exists", {}, "name");
}

/** Non-archived job types (management lists use the query layer; this is a convenience). */
export async function listJobTypes(db: DbLike, ctx: AuthContext, opts: { includeArchived?: boolean } = {}): Promise<JobType[]> {
  return db
    .select()
    .from(jobTypes)
    .where(and(eq(jobTypes.organisationId, ctx.organisationId), opts.includeArchived ? undefined : isNull(jobTypes.archivedAt)))
    .orderBy(asc(jobTypes.sortOrder), asc(jobTypes.name), asc(jobTypes.id));
}

function snapshot(t: JobType) {
  return { name: t.name, colour: t.colour, workflowId: t.workflowId, defaultEstimatedHours: t.defaultEstimatedHours, sortOrder: t.sortOrder };
}

export async function createJobType(tx: Tx, ctx: AuthContext, input: unknown): Promise<JobType> {
  assertCan(ctx, "job_type.manage");
  const data = parseInput(CreateJobTypeInput, input);
  await assertNameFree(tx, ctx, data.name);
  const wf = data.workflowId ? await assertBindableWorkflow(tx, ctx, data.workflowId) : await defaultWorkflowOf(tx, ctx);
  const now = ctx.now();
  const sortOrder = data.sortOrder ?? (await listJobTypes(tx, ctx, { includeArchived: true })).reduce((m, t) => Math.max(m, t.sortOrder + 1), 0);
  const row = await one(
    tx
      .insert(jobTypes)
      .values({
        organisationId: ctx.organisationId,
        name: data.name,
        ...(data.colour ? { colour: data.colour } : {}),
        workflowId: wf.id,
        defaultEstimatedHours: data.defaultEstimatedHours ?? null,
        sortOrder,
        createdAt: now,
        updatedAt: now,
      })
      .returning(),
  );
  await recordEvent(tx, ctx, {
    entityType: "job_type",
    entityId: row.id,
    eventType: "job_type.created",
    action: "created",
    previousValue: null,
    newValue: { ...snapshot(row), workflowName: wf.name },
    metadata: { workflowId: wf.id, jobTypeId: row.id },
  });
  return row;
}

export async function updateJobType(tx: Tx, ctx: AuthContext, input: unknown): Promise<JobType> {
  assertCan(ctx, "job_type.manage");
  const data = parseInput(UpdateJobTypeInput, input);
  const jt = await loadJobTypeInOrg(tx, ctx, data.jobTypeId);
  checkVersion(jt, data.expectedVersion, jt);
  if (jt.archivedAt) throw ruleViolation("This job type is archived; restore it first");
  if (data.name !== undefined) await assertNameFree(tx, ctx, data.name, jt.id);
  const diff = diffFields(jt, data, EDITABLE);
  if (diff.changed.length === 0) return jt;
  const meta: Record<string, unknown> = { workflowId: diff.set.workflowId ?? jt.workflowId, jobTypeId: jt.id };
  if (diff.set.workflowId) {
    const next = await assertBindableWorkflow(tx, ctx, diff.set.workflowId);
    meta.fromLabel = (await loadWorkflowInOrg(tx, ctx, jt.workflowId)).name;
    meta.toLabel = next.name;
  }
  const row = await one(
    tx
      .update(jobTypes)
      .set({ ...diff.set, updatedAt: ctx.now(), version: jt.version + 1 })
      .where(eq(jobTypes.id, jt.id))
      .returning(),
  );
  await recordEvent(tx, ctx, {
    entityType: "job_type",
    entityId: jt.id,
    eventType: "job_type.updated",
    action: "updated",
    previousValue: diff.previous,
    newValue: diff.next,
    metadata: { ...meta, name: row.name },
  });
  return row;
}

/** Hides the type from the new-job form; existing jobs keep it. */
export async function archiveJobType(tx: Tx, ctx: AuthContext, input: unknown): Promise<JobType> {
  assertCan(ctx, "job_type.manage");
  const data = parseInput(JobTypeIdInput, input);
  const jt = await loadJobTypeInOrg(tx, ctx, data.jobTypeId);
  checkVersion(jt, data.expectedVersion, jt);
  if (jt.archivedAt) throw ruleViolation("This job type is already archived");
  const now = ctx.now();
  const row = await one(
    tx
      .update(jobTypes)
      .set({ archivedAt: now, updatedAt: now, version: jt.version + 1 })
      .where(eq(jobTypes.id, jt.id))
      .returning(),
  );
  await recordEvent(tx, ctx, {
    entityType: "job_type",
    entityId: jt.id,
    eventType: "job_type.archived",
    action: "archived",
    previousValue: { archivedAt: null, name: jt.name },
    newValue: { archivedAt: now, name: jt.name },
    metadata: { workflowId: jt.workflowId, jobTypeId: jt.id },
  });
  return row;
}

/** Restores an archived type (audited as job_type.updated archivedAt → null); its workflow must still be bindable. */
export async function restoreJobType(tx: Tx, ctx: AuthContext, input: unknown): Promise<JobType> {
  assertCan(ctx, "job_type.manage");
  const data = parseInput(JobTypeIdInput, input);
  const jt = await loadJobTypeInOrg(tx, ctx, data.jobTypeId);
  checkVersion(jt, data.expectedVersion, jt);
  if (!jt.archivedAt) throw ruleViolation("This job type is not archived");
  await assertBindableWorkflow(tx, ctx, jt.workflowId);
  const row = await one(
    tx
      .update(jobTypes)
      .set({ archivedAt: null, updatedAt: ctx.now(), version: jt.version + 1 })
      .where(eq(jobTypes.id, jt.id))
      .returning(),
  );
  await recordEvent(tx, ctx, {
    entityType: "job_type",
    entityId: jt.id,
    eventType: "job_type.updated",
    action: "restored",
    previousValue: { archivedAt: jt.archivedAt },
    newValue: { archivedAt: null },
    metadata: { workflowId: jt.workflowId, jobTypeId: jt.id, name: jt.name },
  });
  return row;
}
