/**
 * Jobs service (ARCHITECTURE.md §1 job numbers, §2.3, §2.8, §4.5, §5).
 *
 * - `createJob`: gap-free job number (`UPDATE organisations … RETURNING
 *   job_sequence` inside the create tx), `kind='creation'` transition row
 *   into the workflow's initial status, photographer assignment, optional
 *   initial editor (→ `assigned` through the assignment service).
 * - `updateJob`: per-field permissions, one event per changed field,
 *   client/project consistency (client follows the project), version bump.
 * - setters (priority, deadlines stored as end-of-civil-day in the org
 *   timezone, completion %), pause/resume, bulk priority/transition.
 * - `recomputeJobDerived`: repairs every db:verify-derived pointer column
 *   from the ledgers, audited as `job.field_changed` with cause "recompute".
 *
 * Status changes never happen here: they go through ./workflow.
 * Every function is synchronous (better-sqlite3 transactions).
 */
import { and, count, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db, Tx } from "@/db/index";
import {
  activityEvents,
  jobAssignments,
  jobRevisions,
  jobStatusTransitions,
  jobs,
  organisationSettings,
  organisations,
  workflowStatuses,
} from "@/db/schema";
import { CATEGORY_GROUPS, DEFAULT_JOB_NUMBER_PREFIX, JOB_NUMBER_PAD, type Action, type Priority } from "@/lib/constants";
import { newId } from "@/lib/ids";
import type { AuthContext, BulkResult, Job, JobPermissionRef } from "@/lib/types";
import {
  BulkPriorityInput,
  BulkTransitionInput,
  CreateJobInput,
  JobIdInput,
  PauseInput,
  SetCompletionPercentInput,
  SetDateInput,
  SetPriorityInput,
  UpdateJobInput,
  optionalDeadlineToIso,
  type JobFieldsValue,
} from "@/lib/validation/jobs";
import { assertCan, can, isManagement } from "@/server/auth/permissions";
import { systemContext } from "@/server/auth/session";
import { recordEvent } from "@/server/audit";
import { NotFoundError, ValidationError } from "@/server/errors";
import {
  assertVersion,
  loadClientInOrg,
  loadJobTypeInOrg,
  loadProjectInOrg,
  loadUserInOrg,
  loadWorkflowInOrg,
  parseInput,
} from "./_shared";
import { assignEditorToJob, type AssignEditorResult } from "./assignments";
import { notify } from "./notifications";
import {
  closeRunningSessions,
  emitAutomationEvent,
  jobEventMeta,
  jobLinkPath,
  loadVisibleJob,
  runPerJob,
  transitionLoadedJob,
  updateJobRow,
  type JobPatch,
} from "./workflow";

/* ------------------------------------------------------------------ */
/*  createJob                                                          */
/* ------------------------------------------------------------------ */

export interface CreateJobResult {
  job: Job;
  /** The `kind='creation'` transition row. */
  transitionId: string;
  /** The `job.created` event. */
  eventId: string;
  /** Present when an initial editor was assigned (job moved to `assigned`). */
  editorAssignment: AssignEditorResult | null;
}

function nextJobNumber(tx: Tx, organisationId: string): string {
  const seq = tx
    .update(organisations)
    .set({ jobSequence: sql`${organisations.jobSequence} + 1` })
    .where(eq(organisations.id, organisationId))
    .returning({ n: organisations.jobSequence })
    .get();
  if (!seq) throw new NotFoundError("Organisation");
  const settings = tx
    .select({ prefix: organisationSettings.jobNumberPrefix })
    .from(organisationSettings)
    .where(eq(organisationSettings.organisationId, organisationId))
    .get();
  return `${settings?.prefix ?? DEFAULT_JOB_NUMBER_PREFIX}-${String(seq.n).padStart(JOB_NUMBER_PAD, "0")}`;
}

export function createJob(tx: Tx, ctx: AuthContext, input: unknown): CreateJobResult {
  assertCan(ctx, "job.create");
  const p = parseInput(CreateJobInput, input);
  const creatorId = ctx.userId;
  if (!creatorId) throw new ValidationError("Jobs are created by a person");
  const tz = ctx.settings.timezone;

  const project = loadProjectInOrg(tx, ctx, p.projectId);
  if (project.archivedAt) throw new ValidationError("That project is archived", { formErrors: [], fieldErrors: { projectId: ["Archived"] } });
  if (p.clientId !== undefined) {
    loadClientInOrg(tx, ctx, p.clientId);
    if (p.clientId !== project.clientId) {
      throw new ValidationError("The project belongs to a different client", { formErrors: [], fieldErrors: { clientId: ["Does not match the project"] } });
    }
  }
  const client = loadClientInOrg(tx, ctx, project.clientId);
  if (client.archivedAt) throw new ValidationError("That client is archived", { formErrors: [], fieldErrors: { clientId: ["Archived"] } });
  const jobType = loadJobTypeInOrg(tx, ctx, p.jobTypeId);
  if (jobType.archivedAt) throw new ValidationError("That job type is archived", { formErrors: [], fieldErrors: { jobTypeId: ["Archived"] } });
  const workflow = loadWorkflowInOrg(tx, ctx, jobType.workflowId);
  if (workflow.archivedAt) throw new ValidationError("The job type's workflow is archived");
  const initial = tx
    .select()
    .from(workflowStatuses)
    .where(and(eq(workflowStatuses.workflowId, workflow.id), eq(workflowStatuses.isInitial, true), isNull(workflowStatuses.archivedAt)))
    .get();
  if (!initial) throw new ValidationError("The job type's workflow has no initial status");

  const photographerId = p.photographerId !== undefined ? p.photographerId : ctx.role === "photographer" ? creatorId : null;
  if (photographerId) {
    const photographer = loadUserInOrg(tx, ctx, photographerId);
    if (!photographer.isActive) throw new ValidationError(`${photographer.name} is deactivated`, { formErrors: [], fieldErrors: { photographerId: ["Deactivated"] } });
    if (photographer.role === "editor") {
      throw new ValidationError(`${photographer.name} is an editor`, { formErrors: [], fieldErrors: { photographerId: ["Must be a photographer, manager or owner"] } });
    }
  }

  const jobNumber = nextJobNumber(tx, ctx.organisationId);
  const now = ctx.now();
  const jobId = newId();
  const values = {
    id: jobId,
    organisationId: ctx.organisationId,
    jobNumber,
    name: p.name,
    description: p.description ?? null,
    clientId: project.clientId,
    projectId: project.id,
    jobTypeId: jobType.id,
    workflowId: workflow.id,
    priority: p.priority ?? "normal",
    statusId: initial.id,
    statusCategory: initial.category,
    previousStatusId: null,
    statusEnteredAt: now,
    photographerId,
    editorId: null,
    shootDate: optionalDeadlineToIso(p.shootDate, tz) ?? null,
    dueDate: optionalDeadlineToIso(p.dueDate, tz) ?? null,
    reviewDueDate: optionalDeadlineToIso(p.reviewDueDate, tz) ?? null,
    deliveryDueDate: optionalDeadlineToIso(p.deliveryDueDate, tz) ?? null,
    estimatedHours: p.estimatedHours ?? null,
    lastActivityAt: now,
    createdByUserId: creatorId,
    createdAt: now,
    updatedAt: now,
  } satisfies typeof jobs.$inferInsert;
  tx.insert(jobs).values(values).run();

  const transitionId = newId();
  tx.insert(jobStatusTransitions)
    .values({
      id: transitionId,
      organisationId: ctx.organisationId,
      jobId,
      sequence: 1,
      kind: "creation",
      fromStatusId: null,
      toStatusId: initial.id,
      fromCategory: null,
      toCategory: initial.category,
      statusName: initial.name,
      actorUserId: creatorId,
      automationRunId: ctx.automationRunId ?? null,
      enteredAt: now,
      editorIdAtEntry: null,
      photographerIdAtEntry: photographerId,
    })
    .run();

  let photographerAssignmentId: string | null = null;
  if (photographerId) {
    photographerAssignmentId = newId();
    tx.insert(jobAssignments)
      .values({
        id: photographerAssignmentId,
        organisationId: ctx.organisationId,
        jobId,
        role: "photographer",
        userId: photographerId,
        assignedByUserId: creatorId,
        assignedAt: now,
        reason: "Job created",
        statusCategoryAtAssign: initial.category,
      })
      .run();
  }

  const eventId = recordEvent(tx, ctx, {
    entityType: "job",
    entityId: jobId,
    jobId,
    eventType: "job.created",
    action: "created",
    previousValue: null,
    newValue: {
      jobNumber,
      name: values.name,
      clientId: values.clientId,
      projectId: values.projectId,
      jobTypeId: values.jobTypeId,
      workflowId: values.workflowId,
      statusId: values.statusId,
      statusName: initial.name,
      priority: values.priority,
      shootDate: values.shootDate,
      dueDate: values.dueDate,
      reviewDueDate: values.reviewDueDate,
      deliveryDueDate: values.deliveryDueDate,
      photographerId,
      editorId: p.editorId ?? null,
      estimatedHours: values.estimatedHours,
    },
    metadata: jobEventMeta(values, { transitionId }),
  });
  tx.update(jobStatusTransitions).set({ activityEventId: eventId }).where(eq(jobStatusTransitions.id, transitionId)).run();
  if (photographerAssignmentId) {
    tx.update(jobAssignments).set({ activityEventId: eventId }).where(eq(jobAssignments.id, photographerAssignmentId)).run();
    if (photographerId !== creatorId) {
      notify(tx, ctx, {
        userIds: [photographerId],
        type: "job_assigned",
        title: `You are the photographer on ${jobNumber}`,
        body: values.name,
        jobId,
        activityEventId: eventId,
        linkPath: jobLinkPath(jobId),
      });
    }
  }
  emitAutomationEvent(tx, ctx, { eventId, eventType: "job.created", jobId });

  let job = tx.select().from(jobs).where(eq(jobs.id, jobId)).get() as Job;
  let editorAssignment: AssignEditorResult | null = null;
  if (p.editorId) {
    assertCan(ctx, "job.assign_editor", permissionRefOf(job));
    editorAssignment = assignEditorToJob(tx, ctx, job, p.editorId, { reason: "Assigned at creation" });
    job = editorAssignment.job;
  }
  return { job, transitionId, eventId, editorAssignment };
}

function permissionRefOf(job: Job): JobPermissionRef {
  return {
    id: job.id,
    organisationId: job.organisationId,
    photographerId: job.photographerId,
    editorId: job.editorId,
    createdByUserId: job.createdByUserId,
    statusCategory: job.statusCategory,
    isPaused: job.isPaused,
  };
}

/* ------------------------------------------------------------------ */
/*  updateJob + setters                                                */
/* ------------------------------------------------------------------ */

const FIELD_ACTIONS: Record<keyof JobFieldsValue, Action> = {
  name: "job.edit_fields",
  description: "job.edit_fields",
  clientId: "job.edit_fields",
  projectId: "job.edit_fields",
  jobTypeId: "job.edit_fields",
  shootDate: "job.edit_fields",
  estimatedHours: "job.edit_fields",
  priority: "job.set_priority",
  dueDate: "job.set_due_date",
  reviewDueDate: "job.set_review_due_date",
  deliveryDueDate: "job.set_delivery_due_date",
  completionPercent: "job.edit_completion_percent",
};

const DATE_EVENTS = {
  dueDate: "job.due_date_changed",
  reviewDueDate: "job.review_due_date_changed",
  deliveryDueDate: "job.delivery_due_date_changed",
  shootDate: "job.shoot_date_changed",
} as const;
type DateField = keyof typeof DATE_EVENTS;
const DATE_FIELDS = Object.keys(DATE_EVENTS) as DateField[];

type PlainField = "name" | "description" | "clientId" | "projectId" | "jobTypeId" | "estimatedHours" | "completionPercent";

export interface UpdateJobResult {
  job: Job;
  /** Field names that actually changed (one event each). */
  changed: string[];
}

/**
 * Applies field changes to a loaded job (caller loaded it visibly and
 * checked the version). Checks each field's permission, keeps client =
 * project.client, writes ONE version-bumped UPDATE and one event per field.
 */
export function applyJobFieldChanges(
  tx: Tx,
  ctx: AuthContext,
  jobIn: Job,
  ref: JobPermissionRef,
  fields: JobFieldsValue,
  opts: { batchId?: string | null } = {},
): UpdateJobResult {
  const present = (Object.keys(fields) as (keyof JobFieldsValue)[]).filter((k) => fields[k] !== undefined);
  for (const action of new Set(present.map((k) => FIELD_ACTIONS[k]))) assertCan(ctx, action, ref);

  const tz = ctx.settings.timezone;
  const job = jobIn;
  const patch: JobPatch = {};
  const plain: { field: PlainField; from: unknown; to: unknown; fromLabel?: string | null; toLabel?: string | null }[] = [];
  const dates: { field: DateField; from: string | null; to: string | null }[] = [];

  if (fields.name !== undefined && fields.name !== job.name) {
    patch.name = fields.name;
    plain.push({ field: "name", from: job.name, to: fields.name });
  }
  if (fields.description !== undefined) {
    const next = fields.description === null || fields.description === "" ? null : fields.description;
    if (next !== job.description) {
      patch.description = next;
      plain.push({ field: "description", from: job.description, to: next });
    }
  }

  // Client / project consistency: the client always follows the project.
  if (fields.projectId !== undefined || fields.clientId !== undefined) {
    const projectChanged = fields.projectId !== undefined && fields.projectId !== job.projectId;
    const project = loadProjectInOrg(tx, ctx, fields.projectId ?? job.projectId);
    if (projectChanged && project.archivedAt) throw new ValidationError("That project is archived", { formErrors: [], fieldErrors: { projectId: ["Archived"] } });
    if (fields.clientId !== undefined) {
      loadClientInOrg(tx, ctx, fields.clientId);
      if (fields.clientId !== project.clientId) {
        throw new ValidationError(
          projectChanged ? "The project belongs to a different client" : "Choose a project of that client to change the client",
          { formErrors: [], fieldErrors: { clientId: ["Does not match the project"] } },
        );
      }
    }
    if (projectChanged) {
      const oldProject = loadProjectInOrg(tx, ctx, job.projectId);
      patch.projectId = project.id;
      plain.push({ field: "projectId", from: job.projectId, to: project.id, fromLabel: oldProject.name, toLabel: project.name });
      if (project.clientId !== job.clientId) {
        const oldClient = loadClientInOrg(tx, ctx, job.clientId);
        const newClient = loadClientInOrg(tx, ctx, project.clientId);
        patch.clientId = project.clientId;
        plain.push({ field: "clientId", from: job.clientId, to: project.clientId, fromLabel: oldClient.name, toLabel: newClient.name });
      }
    }
  }

  if (fields.jobTypeId !== undefined && fields.jobTypeId !== job.jobTypeId) {
    const next = loadJobTypeInOrg(tx, ctx, fields.jobTypeId);
    if (next.archivedAt) throw new ValidationError("That job type is archived", { formErrors: [], fieldErrors: { jobTypeId: ["Archived"] } });
    const prev = loadJobTypeInOrg(tx, ctx, job.jobTypeId);
    patch.jobTypeId = next.id;
    plain.push({ field: "jobTypeId", from: job.jobTypeId, to: next.id, fromLabel: prev.name, toLabel: next.name });
  }
  if (fields.estimatedHours !== undefined && fields.estimatedHours !== job.estimatedHours) {
    patch.estimatedHours = fields.estimatedHours;
    plain.push({ field: "estimatedHours", from: job.estimatedHours, to: fields.estimatedHours });
  }
  if (fields.completionPercent !== undefined && fields.completionPercent !== job.completionPercent) {
    patch.completionPercent = fields.completionPercent;
    plain.push({ field: "completionPercent", from: job.completionPercent, to: fields.completionPercent });
  }
  let priorityChange: { from: Priority; to: Priority } | null = null;
  if (fields.priority !== undefined && fields.priority !== job.priority) {
    patch.priority = fields.priority;
    priorityChange = { from: job.priority, to: fields.priority };
  }
  for (const field of DATE_FIELDS) {
    const raw = fields[field];
    if (raw === undefined) continue;
    const next = optionalDeadlineToIso(raw, tz) ?? null;
    if (next !== job[field]) {
      patch[field] = next;
      dates.push({ field, from: job[field], to: next });
    }
  }

  if (plain.length === 0 && dates.length === 0 && !priorityChange) return { job, changed: [] };

  const updated = updateJobRow(tx, ctx, job, patch);
  const now = ctx.now();
  const meta = (extra: Record<string, unknown>) => jobEventMeta(updated, extra, opts.batchId);
  const changed: string[] = [];
  const managementActor = isManagement(ctx) && !ctx.isSystem;

  for (const c of plain) {
    recordEvent(tx, ctx, {
      entityType: "job",
      entityId: updated.id,
      jobId: updated.id,
      eventType: "job.field_changed",
      action: "updated",
      previousValue: { field: c.field, value: c.from },
      newValue: { field: c.field, value: c.to },
      metadata: meta({ field: c.field, ...(c.fromLabel !== undefined ? { fromLabel: c.fromLabel, toLabel: c.toLabel } : {}) }),
    });
    changed.push(c.field);
  }

  if (priorityChange) {
    const evt = recordEvent(tx, ctx, {
      entityType: "job",
      entityId: updated.id,
      jobId: updated.id,
      eventType: "job.priority_changed",
      action: "updated",
      previousValue: { priority: priorityChange.from },
      newValue: { priority: priorityChange.to },
      metadata: meta({}),
    });
    notify(tx, ctx, {
      userIds: [updated.editorId, managementActor ? updated.photographerId : null],
      type: "priority_changed",
      title: `${updated.jobNumber} priority is now ${priorityChange.to}`,
      body: updated.name,
      jobId: updated.id,
      activityEventId: evt,
      linkPath: jobLinkPath(updated.id),
    });
    emitAutomationEvent(tx, ctx, { eventId: evt, eventType: "job.priority_changed", jobId: updated.id });
    changed.push("priority");
  }

  for (const d of dates) {
    const deadlineBound = CATEGORY_GROUPS.DEADLINE_BOUND.includes(updated.statusCategory);
    const wasOverdue = d.from !== null && deadlineBound && Date.parse(d.from) < Date.parse(now);
    const evt = recordEvent(tx, ctx, {
      entityType: "job",
      entityId: updated.id,
      jobId: updated.id,
      eventType: DATE_EVENTS[d.field],
      action: "updated",
      previousValue: { value: d.from },
      newValue: { value: d.to },
      metadata: meta({ field: d.field, wasOverdue }),
    });
    if (d.field !== "shootDate") {
      notify(tx, ctx, {
        userIds: [updated.editorId, managementActor ? updated.photographerId : null],
        type: "deadline_changed",
        title: `${updated.jobNumber} deadline changed`,
        body: updated.name,
        jobId: updated.id,
        activityEventId: evt,
        linkPath: jobLinkPath(updated.id),
      });
      emitAutomationEvent(tx, ctx, { eventId: evt, eventType: DATE_EVENTS[d.field], jobId: updated.id });
    }
    changed.push(d.field);
  }

  return { job: updated, changed };
}

/** `PATCH /api/jobs/:id` — any subset of fields, each with its own permission. */
export function updateJob(tx: Tx, ctx: AuthContext, input: unknown): UpdateJobResult {
  const p = parseInput(UpdateJobInput, input);
  const { job, ref } = loadVisibleJob(tx, ctx, p.jobId);
  assertVersion(job, p.expectedVersion);
  const { jobId: _jobId, expectedVersion: _version, ...fields } = p;
  void _jobId;
  void _version;
  return applyJobFieldChanges(tx, ctx, job, ref, fields);
}

function updateOne(tx: Tx, ctx: AuthContext, jobId: string, expectedVersion: number, fields: JobFieldsValue): UpdateJobResult {
  const { job, ref } = loadVisibleJob(tx, ctx, jobId);
  assertVersion(job, expectedVersion);
  return applyJobFieldChanges(tx, ctx, job, ref, fields);
}

export function setPriority(tx: Tx, ctx: AuthContext, input: unknown): UpdateJobResult {
  const p = parseInput(SetPriorityInput, input);
  return updateOne(tx, ctx, p.jobId, p.expectedVersion, { priority: p.priority });
}

/** Civil date (stored as end of that day in the org timezone), ISO instant, or null. */
export function setDueDate(tx: Tx, ctx: AuthContext, input: unknown): UpdateJobResult {
  const p = parseInput(SetDateInput, input);
  return updateOne(tx, ctx, p.jobId, p.expectedVersion, { dueDate: p.value });
}

export function setReviewDueDate(tx: Tx, ctx: AuthContext, input: unknown): UpdateJobResult {
  const p = parseInput(SetDateInput, input);
  return updateOne(tx, ctx, p.jobId, p.expectedVersion, { reviewDueDate: p.value });
}

export function setDeliveryDueDate(tx: Tx, ctx: AuthContext, input: unknown): UpdateJobResult {
  const p = parseInput(SetDateInput, input);
  return updateOne(tx, ctx, p.jobId, p.expectedVersion, { deliveryDueDate: p.value });
}

export function setShootDate(tx: Tx, ctx: AuthContext, input: unknown): UpdateJobResult {
  const p = parseInput(SetDateInput, input);
  return updateOne(tx, ctx, p.jobId, p.expectedVersion, { shootDate: p.value });
}

export function setCompletionPercent(tx: Tx, ctx: AuthContext, input: unknown): UpdateJobResult {
  const p = parseInput(SetCompletionPercentInput, input);
  return updateOne(tx, ctx, p.jobId, p.expectedVersion, { completionPercent: p.completionPercent });
}

/* ------------------------------------------------------------------ */
/*  Pause / resume                                                     */
/* ------------------------------------------------------------------ */

export interface PauseResult {
  job: Job;
  eventId: string;
  /** Sessions closed by the pause (`end_reason = paused`). */
  closedSessionIds: string[];
}

/** Editor (or O/M on behalf) pauses work while in an EDITOR_WORKING status; closes the running timer. */
export function pauseJob(tx: Tx, ctx: AuthContext, input: unknown): PauseResult {
  const p = parseInput(PauseInput, input);
  const { job: loaded, ref } = loadVisibleJob(tx, ctx, p.jobId);
  assertCan(ctx, "job.pause", ref);
  assertVersion(loaded, p.expectedVersion);
  if (loaded.isPaused) throw new ValidationError("Work on this job is already paused");
  const closedSessionIds = closeRunningSessions(tx, ctx, { jobId: loaded.id }, "paused", "user");
  const job = updateJobRow(tx, ctx, loaded, { isPaused: true, pausedAt: ctx.now() });
  const onBehalfOf = isManagement(ctx) && job.editorId && job.editorId !== ctx.userId ? job.editorId : undefined;
  const eventId = recordEvent(tx, ctx, {
    entityType: "job",
    entityId: job.id,
    jobId: job.id,
    eventType: "job.paused",
    action: "paused",
    previousValue: { isPaused: false },
    newValue: { isPaused: true },
    metadata: jobEventMeta(job, { sessionId: closedSessionIds[0] ?? null, reason: p.reason ?? null, ...(onBehalfOf ? { onBehalfOf } : {}) }),
  });
  notify(tx, ctx, {
    userIds: [job.photographerId],
    type: "job_paused",
    title: `Work on ${job.jobNumber} was paused`,
    body: p.reason ?? job.name,
    jobId: job.id,
    activityEventId: eventId,
    linkPath: jobLinkPath(job.id),
  });
  return { job, eventId, closedSessionIds };
}

export function resumeJob(tx: Tx, ctx: AuthContext, input: unknown): PauseResult {
  const p = parseInput(PauseInput, input);
  const { job: loaded, ref } = loadVisibleJob(tx, ctx, p.jobId);
  assertCan(ctx, "job.pause", ref);
  assertVersion(loaded, p.expectedVersion);
  if (!loaded.isPaused) throw new ValidationError("Work on this job is not paused");
  const job = updateJobRow(tx, ctx, loaded, { isPaused: false, pausedAt: null });
  const onBehalfOf = isManagement(ctx) && job.editorId && job.editorId !== ctx.userId ? job.editorId : undefined;
  const eventId = recordEvent(tx, ctx, {
    entityType: "job",
    entityId: job.id,
    jobId: job.id,
    eventType: "job.resumed",
    action: "resumed",
    previousValue: { isPaused: true },
    newValue: { isPaused: false },
    metadata: jobEventMeta(job, { pausedAt: loaded.pausedAt, reason: p.reason ?? null, ...(onBehalfOf ? { onBehalfOf } : {}) }),
  });
  return { job, eventId, closedSessionIds: [] };
}

/* ------------------------------------------------------------------ */
/*  Bulk                                                               */
/* ------------------------------------------------------------------ */

/** `POST /api/jobs/bulk/priority` — one tx per job, per-job `job.set_priority`. */
export function bulkSetPriority(ctx: AuthContext, input: unknown, options: { db?: Db } = {}): BulkResult {
  const p = parseInput(BulkPriorityInput, input);
  return runPerJob(
    p.jobIds,
    (tx, jobId, batchId) => {
      const { job, ref } = loadVisibleJob(tx, ctx, jobId);
      applyJobFieldChanges(tx, ctx, job, ref, { priority: p.priority }, { batchId });
    },
    { ...options, organisationId: ctx.organisationId },
  );
}

/** `POST /api/jobs/bulk/transition` — one tx per job through the workflow engine. */
export function bulkTransition(ctx: AuthContext, input: unknown, options: { db?: Db } = {}): BulkResult {
  const p = parseInput(BulkTransitionInput, input);
  return runPerJob(
    p.jobIds,
    (tx, jobId, batchId) => {
      transitionLoadedJob(tx, ctx, jobId, { toStatusId: p.toStatusId, toCategory: p.toCategory }, { reason: p.reason, override: p.override, batchId });
    },
    { ...options, organisationId: ctx.organisationId },
  );
}

/* ------------------------------------------------------------------ */
/*  recomputeJobDerived (§2.8)                                         */
/* ------------------------------------------------------------------ */

export interface DerivedChange {
  column: string;
  stored: unknown;
  derived: unknown;
}

export interface RecomputeResult {
  jobId: string;
  job: Job;
  changes: DerivedChange[];
}

/**
 * Rewrites the pointer columns db:verify derives (status pointers,
 * completed_at / cancelled_at of the open stage, people, previous editor,
 * revision count / open revision, reopened_count, is_paused outside
 * EDITOR_WORKING, last_activity_at) from the ledgers. One `job.field_changed`
 * event per repaired column (metadata.cause = "recompute"; last_activity_at
 * is an audit exemption). Milestone timestamps (started_at, approved_at, …)
 * and deadline snapshots are not rebuilt. `ctx` defaults to a system
 * context of the job's organisation.
 */
export function recomputeJobDerived(tx: Tx, jobId: string, ctxIn?: AuthContext): RecomputeResult {
  const job = tx.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job || (ctxIn && ctxIn.organisationId !== job.organisationId)) throw new NotFoundError("Job");
  const ctx: AuthContext = ctxIn ? { ...ctxIn, cause: "recompute" } : systemContext(job.organisationId, { db: tx, cause: "recompute" });

  const derived: Partial<Record<keyof Job, unknown>> = {};
  const open = tx
    .select()
    .from(jobStatusTransitions)
    .where(and(eq(jobStatusTransitions.jobId, job.id), isNull(jobStatusTransitions.exitedAt)))
    .all();
  if (open.length !== 1) {
    throw new ValidationError(`Job ${job.jobNumber} has ${open.length} open stages; the transition ledger needs manual repair`);
  }
  const stage = open[0];
  const status = tx.select().from(workflowStatuses).where(eq(workflowStatuses.id, stage.toStatusId)).get();
  if (!status) throw new NotFoundError("Status");
  derived.statusId = stage.toStatusId;
  derived.workflowId = status.workflowId;
  derived.statusCategory = status.category;
  derived.previousStatusId = stage.fromStatusId ?? null;
  derived.statusEnteredAt = stage.enteredAt;
  derived.completedAt = stage.toCategory === "completed" ? stage.enteredAt : null;
  derived.cancelledAt = stage.toCategory === "cancelled" ? stage.enteredAt : null;

  const openAssignment = (role: "photographer" | "editor") =>
    tx
      .select({ userId: jobAssignments.userId })
      .from(jobAssignments)
      .where(and(eq(jobAssignments.jobId, job.id), eq(jobAssignments.role, role), isNull(jobAssignments.unassignedAt)))
      .get()?.userId ?? null;
  derived.photographerId = openAssignment("photographer");
  derived.editorId = openAssignment("editor");
  derived.previousEditorId =
    tx
      .select({ userId: jobAssignments.userId })
      .from(jobAssignments)
      .where(and(eq(jobAssignments.jobId, job.id), eq(jobAssignments.role, "editor"), isNotNull(jobAssignments.unassignedAt)))
      .orderBy(desc(jobAssignments.unassignedAt), desc(jobAssignments.assignedAt))
      .get()?.userId ?? null;

  derived.revisionCount =
    tx
      .select({ n: sql<number>`coalesce(max(${jobRevisions.revisionNumber}), 0)` })
      .from(jobRevisions)
      .where(eq(jobRevisions.jobId, job.id))
      .get()?.n ?? 0;
  derived.openRevisionId =
    tx
      .select({ id: jobRevisions.id })
      .from(jobRevisions)
      .where(and(eq(jobRevisions.jobId, job.id), isNull(jobRevisions.resolvedAt)))
      .get()?.id ?? null;
  derived.reopenedCount =
    tx
      .select({ n: count() })
      .from(jobStatusTransitions)
      .where(and(eq(jobStatusTransitions.jobId, job.id), eq(jobStatusTransitions.isReopen, true)))
      .get()?.n ?? 0;
  if (job.isPaused && !CATEGORY_GROUPS.EDITOR_WORKING.includes(status.category)) {
    derived.isPaused = false;
    derived.pausedAt = null;
  }
  const lastEvent = tx
    .select({ at: sql<string | null>`max(${activityEvents.createdAt})` })
    .from(activityEvents)
    .where(eq(activityEvents.jobId, job.id))
    .get()?.at;
  if (lastEvent) derived.lastActivityAt = lastEvent;

  const changes: DerivedChange[] = [];
  const patch: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(derived) as [keyof Job, unknown][]) {
    if (job[column] !== value) {
      changes.push({ column, stored: job[column], derived: value });
      patch[column] = value;
    }
  }
  if (changes.length === 0) return { jobId: job.id, job, changes };

  const now = ctx.now();
  tx.update(jobs)
    .set({ ...(patch as Partial<typeof jobs.$inferInsert>), version: job.version + 1, updatedAt: now })
    .where(eq(jobs.id, job.id))
    .run();
  for (const c of changes) {
    if (c.column === "lastActivityAt") continue; // audit exemption (§5)
    recordEvent(tx, ctx, {
      entityType: "job",
      entityId: job.id,
      jobId: job.id,
      eventType: "job.field_changed",
      action: "updated",
      previousValue: { field: c.column, value: c.stored },
      newValue: { field: c.column, value: c.derived },
      metadata: jobEventMeta(job, { field: c.column, cause: "recompute", repaired: true }),
    });
  }
  const fresh = tx.select().from(jobs).where(eq(jobs.id, job.id)).get() as Job;
  return { jobId: job.id, job: fresh, changes };
}

/** `POST /api/jobs/:id/recompute` — owner-only repair (`system.integrity`). */
export function repairJob(tx: Tx, ctx: AuthContext, input: unknown): RecomputeResult {
  assertCan(ctx, "system.integrity");
  const p = parseInput(JobIdInput, input);
  const { job } = loadVisibleJob(tx, ctx, p.jobId);
  return recomputeJobDerived(tx, job.id, ctx);
}

/** True when the actor may edit any job field (UI helper). */
export function canEditJobFields(ctx: AuthContext, ref: JobPermissionRef): boolean {
  return can(ctx, "job.edit_fields", ref);
}
