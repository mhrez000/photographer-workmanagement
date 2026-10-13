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
 * Every function is async (Postgres); callers await them inside one `withTx`.
 */
import { and, asc, count, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { first, one, type Db, type DbLike, type Tx } from "@/db/index";
import {
  activityEvents,
  jobAssignments,
  jobRevisions,
  jobStatusTransitions,
  jobs,
  organisationSettings,
  organisations,
  projects,
  users,
  workflowStatuses,
} from "@/db/schema";
import { CATEGORY_GROUPS, DEFAULT_JOB_NUMBER_PREFIX, DEFAULT_USUAL_DAYS_TO_EDIT, JOB_NUMBER_PAD, normaliseProjectKey, type Action, type Priority } from "@/lib/constants";
import { addCivilDays, civilDate } from "@/lib/dates";
import { describeStage, type StageDisplay } from "@/lib/stages";
import { newId } from "@/lib/ids";
import type { AuthContext, BulkResult, Job, JobPermissionRef, Project, User } from "@/lib/types";
import {
  BulkPriorityInput,
  BulkTransitionInput,
  ClaimJobInput,
  CreateJobInput,
  JobIdInput,
  PauseInput,
  SetCompletionPercentInput,
  SetDateInput,
  SetPriorityInput,
  UpdateJobInput,
  optionalDeadlineToIso,
  type AutoProjectInputValue,
  type JobFieldsValue,
} from "@/lib/validation/jobs";
import { assertCan, can, isAdmin, jobRefFromRow } from "@/server/auth/permissions";
import { systemContext } from "@/server/auth/session";
import { recordEvent } from "@/server/audit";
import { ForbiddenError, NotFoundError, RuleViolationError, ValidationError } from "@/server/errors";
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
import { adminsOf, notify } from "./notifications";
import { isClientVisible, resetSharingForClientChange, type ClientChangeResetResult } from "./sharing";
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
  /** The simplified stage the job landed in (SIMPLIFICATION-PLAN §4): needs_editor, or with_editor when an editor was picked. */
  stage: StageDisplay;
  /** Set when the job was created through `autoProject` (plan §5): whether an existing project was reused. */
  autoProject?: { projectId: string; reused: boolean };
}

/**
 * The silent project of the simplified New job form (plan §5 "Projects disappear from the form"): an
 * existing non-archived project of the client whose name OR address equals the typed address
 * (case- and whitespace-insensitive, AUTO_PROJECT_RULE; the oldest match wins), else one created from
 * the address through `createInlineProject` (same permission, same event).
 */
async function resolveAutoProject(tx: Tx, ctx: AuthContext, input: AutoProjectInputValue): Promise<{ project: Project; reused: boolean }> {
  const client = await loadClientInOrg(tx, ctx, input.clientId);
  if (client.archivedAt) throw fieldError("That client is archived", "clientId", "Archived");
  const key = normaliseProjectKey(input.address);
  const rows = await tx
    .select()
    .from(projects)
    .where(and(eq(projects.organisationId, ctx.organisationId), eq(projects.clientId, client.id), isNull(projects.archivedAt)))
    .orderBy(asc(projects.createdAt), asc(projects.id));
  const match = rows.find((p) => normaliseProjectKey(p.name) === key || normaliseProjectKey(p.address) === key);
  if (match) return { project: match, reused: true };
  const address = input.address.trim().replace(/\s+/g, " ");
  return { project: await createInlineProject(tx, ctx, client.id, { name: address, address }), reused: false };
}

/**
 * Default due date of the simplified form (plan §5): shoot date + the type's usual days to edit
 * (DEFAULT_USUAL_DAYS_TO_EDIT when unset), as a civil date in the org timezone. Only when the caller
 * gave a shoot date and said nothing about the due date (`undefined`; `null` clears it explicitly).
 */
export function defaultDueDateFor(shootDate: string | null | undefined, usualDaysToEdit: number | null | undefined, timeZone: string): string | undefined {
  if (!shootDate) return undefined;
  const civil = /^\d{4}-\d{2}-\d{2}$/.test(shootDate) ? shootDate : civilDate(shootDate, timeZone);
  if (!civil) return undefined;
  return addCivilDays(civil, usualDaysToEdit ?? DEFAULT_USUAL_DAYS_TO_EDIT);
}

async function nextJobNumber(tx: Tx, organisationId: string): Promise<string> {
  const seq = await first(
    tx
      .update(organisations)
      .set({ jobSequence: sql`${organisations.jobSequence} + 1` })
      .where(eq(organisations.id, organisationId))
      .returning({ n: organisations.jobSequence }),
  );
  if (!seq) throw new NotFoundError("Organisation");
  const settings = await first(
    tx
      .select({ prefix: organisationSettings.jobNumberPrefix })
      .from(organisationSettings)
      .where(eq(organisationSettings.organisationId, organisationId)),
  );
  return `${settings?.prefix ?? DEFAULT_JOB_NUMBER_PREFIX}-${String(seq.n).padStart(JOB_NUMBER_PAD, "0")}`;
}

/** 422 with one field error (assignee / target validation is allow-list only, §3.4). */
function fieldError(message: string, field: string, detail: string): ValidationError {
  return new RuleViolationError(message, { formErrors: [], fieldErrors: { [field]: [detail] } });
}

/** An active photographer of the actor's organisation (allow-list, §3.4); else 422 / 404 (foreign). */
async function loadActivePhotographer(tx: Tx, ctx: AuthContext, userId: string, field = "photographerId"): Promise<User> {
  const user = await loadUserInOrg(tx, ctx, userId);
  if (!user.isActive) throw fieldError(`${user.name} is deactivated`, field, "Deactivated");
  if (user.role !== "photographer") throw fieldError(`${user.name} is not a photographer`, field, "Must be a photographer");
  return user;
}

/**
 * Photographer pre-filled for jobs editors create (§4.3): the org's
 * `default_photographer_user_id` when it is an active photographer, else the
 * primary owner. Null only if neither resolves (never on a valid org).
 */
export async function defaultPhotographerId(db: DbLike, organisationId: string): Promise<string | null> {
  const settings = await first(
    db
      .select({ defaultId: organisationSettings.defaultPhotographerUserId, ownerId: organisationSettings.primaryOwnerUserId })
      .from(organisationSettings)
      .where(eq(organisationSettings.organisationId, organisationId)),
  );
  if (!settings) return null;
  for (const id of [settings.defaultId, settings.ownerId]) {
    if (!id) continue;
    const row = await first(
      db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, id), eq(users.organisationId, organisationId), eq(users.role, "photographer"), eq(users.isActive, true))),
    );
    if (row) return row.id;
  }
  return null;
}

/**
 * Who the photographer of a new job is (§3.3 job.create, §4.1–§4.3):
 * - admin: any active photographer; omitted → self; null → none
 * - team member: always themselves (another id → 403 job.assign_photographer)
 * - editor: required; omitted → the default photographer; null → 422
 */
async function resolveCreatePhotographer(tx: Tx, ctx: AuthContext, requested: string | null | undefined, creatorId: string): Promise<string | null> {
  if (ctx.role === "editor") {
    if (requested === null) throw fieldError("Choose the photographer of this job", "photographerId", "Required");
    const id = requested ?? (await defaultPhotographerId(tx, ctx.organisationId));
    if (!id) throw fieldError("Choose the photographer of this job", "photographerId", "Required");
    return (await loadActivePhotographer(tx, ctx, id)).id;
  }
  if (isAdmin(ctx)) {
    if (requested === null) return null;
    return (await loadActivePhotographer(tx, ctx, requested ?? creatorId)).id;
  }
  // Team member: the photographer is forced to self.
  if (requested !== undefined && requested !== creatorId) throw new ForbiddenError("job.assign_photographer", "Team members are the photographer on jobs they create");
  return (await loadActivePhotographer(tx, ctx, creatorId)).id;
}

/**
 * The inline "New project" of the New job form (§4.3): `project.create` with
 * `inlineFromJobCreate` (editors may create projects only this way), under an
 * existing non-archived client of the org; event `project.created` (actor =
 * creator) before `job.created`. Never shared with the client.
 */
async function createInlineProject(tx: Tx, ctx: AuthContext, clientId: string, input: { name: string; address?: string | null }): Promise<Project> {
  assertCan(ctx, "project.create", { organisationId: ctx.organisationId, inlineFromJobCreate: true });
  const client = await loadClientInOrg(tx, ctx, clientId);
  if (client.archivedAt) throw fieldError("That client is archived", "clientId", "Archived");
  const now = ctx.now();
  const project = await one(
    tx
      .insert(projects)
      .values({
        organisationId: ctx.organisationId,
        clientId: client.id,
        name: input.name,
        address: input.address ?? null,
        createdByUserId: ctx.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning(),
    "project",
  );
  await recordEvent(tx, ctx, {
    entityType: "project",
    entityId: project.id,
    eventType: "project.created",
    action: "created",
    previousValue: null,
    newValue: {
      clientId: project.clientId,
      name: project.name,
      address: project.address,
      description: project.description,
      startDate: project.startDate,
      endDate: project.endDate,
    },
    metadata: { projectId: project.id, clientName: client.name, inlineFromJobCreate: true },
  });
  return project;
}

export async function createJob(tx: Tx, ctx: AuthContext, input: unknown): Promise<CreateJobResult> {
  assertCan(ctx, "job.create");
  const p = parseInput(CreateJobInput, input);
  const creatorId = ctx.userId;
  if (!creatorId) throw new ValidationError("Jobs are created by a person");
  const tz = ctx.settings.timezone;

  // Editors: the initial editor is themselves ("Assign to me", checked with job.claim below) or nobody.
  if (ctx.role === "editor" && p.editorId && p.editorId !== creatorId) {
    throw new ForbiddenError("job.assign_editor", "Editors can only assign a job they create to themselves");
  }

  let project: Project;
  let autoProject: CreateJobResult["autoProject"];
  if (p.autoProject) {
    const resolved = await resolveAutoProject(tx, ctx, p.autoProject);
    project = resolved.project;
    autoProject = { projectId: project.id, reused: resolved.reused };
  } else if (p.newProject) {
    project = await createInlineProject(tx, ctx, p.clientId as string, p.newProject);
  } else {
    project = await loadProjectInOrg(tx, ctx, p.projectId as string);
    if (project.archivedAt) throw fieldError("That project is archived", "projectId", "Archived");
    if (p.clientId !== undefined) {
      await loadClientInOrg(tx, ctx, p.clientId);
      if (p.clientId !== project.clientId) throw fieldError("The project belongs to a different client", "clientId", "Does not match the project");
    }
  }
  const client = await loadClientInOrg(tx, ctx, project.clientId);
  if (client.archivedAt) throw fieldError("That client is archived", "clientId", "Archived");
  const jobType = await loadJobTypeInOrg(tx, ctx, p.jobTypeId);
  if (jobType.archivedAt) throw fieldError("That job type is archived", "jobTypeId", "Archived");
  const workflow = await loadWorkflowInOrg(tx, ctx, jobType.workflowId);
  if (workflow.archivedAt) throw new ValidationError("The job type's workflow is archived");
  const initial = await first(
    tx
      .select()
      .from(workflowStatuses)
      .where(and(eq(workflowStatuses.workflowId, workflow.id), eq(workflowStatuses.isInitial, true), isNull(workflowStatuses.archivedAt)))
      .orderBy(asc(workflowStatuses.sortOrder), asc(workflowStatuses.id))
      .limit(1),
  );
  if (!initial) throw new ValidationError("The job type's workflow has no initial status");

  const photographerId = await resolveCreatePhotographer(tx, ctx, p.photographerId, creatorId);
  const createdByRole: "photographer" | "editor" = ctx.role === "editor" ? "editor" : "photographer";

  const jobNumber = await nextJobNumber(tx, ctx.organisationId);
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
    // Plan §5: due date defaults to shoot date + the type's usual days to edit when the form says nothing.
    dueDate: optionalDeadlineToIso(p.dueDate === undefined ? defaultDueDateFor(p.shootDate, jobType.usualDaysToEdit, tz) : p.dueDate, tz) ?? null,
    reviewDueDate: optionalDeadlineToIso(p.reviewDueDate, tz) ?? null,
    deliveryDueDate: optionalDeadlineToIso(p.deliveryDueDate, tz) ?? null,
    estimatedHours: p.estimatedHours ?? null,
    lastActivityAt: now,
    createdByUserId: creatorId,
    // roles v2 (docs/ROLES.md §1.2, §4.3): role of the creator AT CREATION, never updated.
    createdByRole,
    createdAt: now,
    updatedAt: now,
  } satisfies typeof jobs.$inferInsert;
  await tx.insert(jobs).values(values);

  const transitionId = newId();
  await tx.insert(jobStatusTransitions)
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
    });

  let photographerAssignmentId: string | null = null;
  if (photographerId) {
    photographerAssignmentId = newId();
    await tx.insert(jobAssignments)
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
      });
  }

  const eventId = await recordEvent(tx, ctx, {
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
    metadata: jobEventMeta(values, {
      transitionId,
      creatorRole: createdByRole,
      ...(p.newProject ? { newProjectId: project.id } : {}),
      ...(autoProject ? { autoProject } : {}),
    }),
  });
  await tx.update(jobStatusTransitions).set({ activityEventId: eventId }).where(eq(jobStatusTransitions.id, transitionId));
  const assignedPhotographer = photographerAssignmentId !== null && photographerId !== null && photographerId !== creatorId ? photographerId : null;
  if (photographerAssignmentId) {
    await tx.update(jobAssignments).set({ activityEventId: eventId }).where(eq(jobAssignments.id, photographerAssignmentId));
  }
  if (assignedPhotographer) {
    await notify(tx, ctx, {
      userIds: [assignedPhotographer],
      type: "job_assigned",
      title: `You are the photographer on ${jobNumber}`,
      body: values.name,
      jobId,
      activityEventId: eventId,
      linkPath: jobLinkPath(jobId),
    });
  }
  await emitAutomationEvent(tx, ctx, { eventId, eventType: "job.created", jobId });

  let job: Job = await one(tx.select().from(jobs).where(eq(jobs.id, jobId)), "job");
  let editorAssignment: AssignEditorResult | null = null;
  if (p.editorId) {
    if (ctx.role === "editor") {
      // "Assign to me" (§4.3): the creator's claim on the just-inserted draft.
      assertCan(ctx, "job.claim", permissionRefOf(job));
      editorAssignment = await assignEditorToJob(tx, ctx, job, creatorId, { reason: "Self-assigned at creation" });
    } else {
      assertCan(ctx, "job.assign_editor", permissionRefOf(job));
      editorAssignment = await assignEditorToJob(tx, ctx, job, p.editorId, { reason: "Assigned at creation" });
    }
    job = editorAssignment.job;
  } else if (createdByRole === "editor") {
    // Left unassigned by an editor: admins (and the photographer when they may assign editors)
    // learn it needs an editor. The photographer already got job_assigned → one notice each.
    const recipients = new Set(await adminsOf(tx, ctx.organisationId));
    if (photographerId) {
      const photographer = await loadUserInOrg(tx, ctx, photographerId);
      if (!photographer.isAdmin && photographer.canAssignEditors) recipients.add(photographerId);
    }
    if (assignedPhotographer) recipients.delete(assignedPhotographer);
    const creator = await loadUserInOrg(tx, ctx, creatorId);
    await notify(tx, ctx, {
      userIds: [...recipients],
      type: "job_created",
      title: `${creator.name} created ${jobNumber} and it needs an editor`,
      body: values.name,
      jobId,
      activityEventId: eventId,
      linkPath: jobLinkPath(jobId),
    });
  }
  return {
    job,
    transitionId,
    eventId,
    editorAssignment,
    stage: describeStage({ category: job.statusCategory, revisionCount: job.revisionCount, startedAt: job.startedAt, statusEnteredAt: job.statusEnteredAt }),
    ...(autoProject ? { autoProject } : {}),
  };
}

/** Ref of a job just created in this transaction: never started/cancelled, no editor removed (draft window open). */
function permissionRefOf(job: Job): JobPermissionRef {
  return jobRefFromRow(job, { draftClosed: false, pastEditorIds: [] });
}

/* ------------------------------------------------------------------ */
/*  claimJob                                                           */
/* ------------------------------------------------------------------ */

/**
 * `POST /api/jobs/:id/claim { expectedVersion }` — an editor takes an
 * unassigned job they created, later (§4.3). Requires the draft window
 * (`job.claim`): never started, never cancelled, nobody else removed an
 * editor — so an admin's unassign can never be overridden by a claim.
 */
export async function claimJob(tx: Tx, ctx: AuthContext, input: unknown): Promise<AssignEditorResult> {
  const p = parseInput(ClaimJobInput, input);
  const { job, ref } = await loadVisibleJob(tx, ctx, p.jobId);
  assertCan(ctx, "job.claim", ref);
  assertVersion(job, p.expectedVersion);
  const me = ctx.userId;
  if (!me) throw new ValidationError("Jobs are claimed by a person");
  return assignEditorToJob(tx, ctx, job, me, { reason: "Claimed by the editor who created it" });
}

/* ------------------------------------------------------------------ */
/*  updateJob + setters                                                */
/* ------------------------------------------------------------------ */

const FIELD_ACTIONS: Record<keyof JobFieldsValue, Action> = {
  name: "job.edit_fields",
  description: "job.edit_fields",
  // roles v2: client / project moves are their own action (controls / draft, §3.3 ◊).
  clientId: "job.change_client",
  projectId: "job.change_client",
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
  /** Present when the job moved to another client (§4.5 sharing reset). */
  clientChangeReset?: ClientChangeResetResult;
}

/** Whether `fields[key]` differs from the job's stored value (dates compared as stored instants). */
function fieldChanges(job: Job, key: keyof JobFieldsValue, fields: JobFieldsValue, tz: string): boolean {
  switch (key) {
    case "dueDate":
    case "reviewDueDate":
    case "deliveryDueDate":
    case "shootDate":
      return (optionalDeadlineToIso(fields[key], tz) ?? null) !== job[key];
    case "description": {
      const next = fields.description === null || fields.description === "" ? null : fields.description;
      return next !== job.description;
    }
    default:
      return fields[key] !== job[key];
  }
}

/**
 * Applies field changes to a loaded job (caller loaded it visibly and
 * checked the version). Checks each field's permission, keeps client =
 * project.client, writes ONE version-bumped UPDATE and one event per field.
 */
export async function applyJobFieldChanges(
  tx: Tx,
  ctx: AuthContext,
  jobIn: Job,
  ref: JobPermissionRef,
  fields: JobFieldsValue,
  opts: { batchId?: string | null } = {},
): Promise<UpdateJobResult> {
  const tz = ctx.settings.timezone;
  // Only fields that actually change are permission-checked: forms send every field, and an
  // unchanged date or project must not need the (narrower) permission of changing it.
  const present = (Object.keys(fields) as (keyof JobFieldsValue)[]).filter((k) => fields[k] !== undefined && fieldChanges(jobIn, k, fields, tz));
  for (const action of new Set(present.map((k) => FIELD_ACTIONS[k]))) assertCan(ctx, action, ref);

  const job = jobIn;
  const patch: JobPatch = {};
  const plain: { field: PlainField; from: unknown; to: unknown; fromLabel?: string | null; toLabel?: string | null }[] = [];
  let clientChanged = false;
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
    const project = await loadProjectInOrg(tx, ctx, fields.projectId ?? job.projectId);
    if (projectChanged && project.archivedAt) throw new ValidationError("That project is archived", { formErrors: [], fieldErrors: { projectId: ["Archived"] } });
    if (fields.clientId !== undefined) {
      await loadClientInOrg(tx, ctx, fields.clientId);
      if (fields.clientId !== project.clientId) {
        throw new ValidationError(
          projectChanged ? "The project belongs to a different client" : "Choose a project of that client to change the client",
          { formErrors: [], fieldErrors: { clientId: ["Does not match the project"] } },
        );
      }
    }
    if (projectChanged) {
      // §4.5 ◊: a move that could publish (the job is client-visible now, or the target project is
      // shared) also needs the share permission.
      if (isClientVisible(job, ref) || project.sharedWithClient) assertCan(ctx, "job.share_with_client", ref);
      const oldProject = await loadProjectInOrg(tx, ctx, job.projectId);
      patch.projectId = project.id;
      plain.push({ field: "projectId", from: job.projectId, to: project.id, fromLabel: oldProject.name, toLabel: project.name });
      if (project.clientId !== job.clientId) {
        const oldClient = await loadClientInOrg(tx, ctx, job.clientId);
        const newClient = await loadClientInOrg(tx, ctx, project.clientId);
        patch.clientId = project.clientId;
        // A new client never inherits the old client's view of this job (§4.5 step 2).
        if (job.sharedWithClient) patch.sharedWithClient = false;
        clientChanged = true;
        plain.push({ field: "clientId", from: job.clientId, to: project.clientId, fromLabel: oldClient.name, toLabel: newClient.name });
      }
    }
  }

  if (fields.jobTypeId !== undefined && fields.jobTypeId !== job.jobTypeId) {
    const next = await loadJobTypeInOrg(tx, ctx, fields.jobTypeId);
    if (next.archivedAt) throw new ValidationError("That job type is archived", { formErrors: [], fieldErrors: { jobTypeId: ["Archived"] } });
    const prev = await loadJobTypeInOrg(tx, ctx, job.jobTypeId);
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

  const updated = await updateJobRow(tx, ctx, job, patch);
  const now = ctx.now();
  const meta = (extra: Record<string, unknown>) => jobEventMeta(updated, extra, opts.batchId);
  const changed: string[] = [];
  const managementActor = isAdmin(ctx) && !ctx.isSystem;

  for (const c of plain) {
    await recordEvent(tx, ctx, {
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
    const evt = await recordEvent(tx, ctx, {
      entityType: "job",
      entityId: updated.id,
      jobId: updated.id,
      eventType: "job.priority_changed",
      action: "updated",
      previousValue: { priority: priorityChange.from },
      newValue: { priority: priorityChange.to },
      metadata: meta({}),
    });
    await notify(tx, ctx, {
      userIds: [updated.editorId, managementActor ? updated.photographerId : null],
      type: "priority_changed",
      title: `${updated.jobNumber} priority is now ${priorityChange.to}`,
      body: updated.name,
      jobId: updated.id,
      activityEventId: evt,
      linkPath: jobLinkPath(updated.id),
    });
    await emitAutomationEvent(tx, ctx, { eventId: evt, eventType: "job.priority_changed", jobId: updated.id });
    changed.push("priority");
  }

  for (const d of dates) {
    const deadlineBound = CATEGORY_GROUPS.DEADLINE_BOUND.includes(updated.statusCategory);
    const wasOverdue = d.from !== null && deadlineBound && Date.parse(d.from) < Date.parse(now);
    const evt = await recordEvent(tx, ctx, {
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
      await notify(tx, ctx, {
        userIds: [updated.editorId, managementActor ? updated.photographerId : null],
        type: "deadline_changed",
        title: `${updated.jobNumber} deadline changed`,
        body: updated.name,
        jobId: updated.id,
        activityEventId: evt,
        linkPath: jobLinkPath(updated.id),
      });
      await emitAutomationEvent(tx, ctx, { eventId: evt, eventType: DATE_EVENTS[d.field], jobId: updated.id });
    }
    changed.push(d.field);
  }

  const clientChangeReset = clientChanged ? await resetSharingForClientChange(tx, ctx, job, updated) : undefined;
  return { job: updated, changed, ...(clientChangeReset ? { clientChangeReset } : {}) };
}

/**
 * Coarse write gate run BEFORE the version check: an actor holding none of the
 * field actions on this job (a read-only viewer) gets 403, never a 409 that
 * carries the stored row. The per-field checks in `applyJobFieldChanges` stay.
 */
function assertMayEditSomeField(ctx: AuthContext, ref: JobPermissionRef): void {
  const actions = [...new Set(Object.values(FIELD_ACTIONS))];
  if (actions.some((a) => can(ctx, a, ref))) return;
  assertCan(ctx, "job.edit_fields", ref);
}

/** `PATCH /api/jobs/:id` — any subset of fields, each with its own permission. */
export async function updateJob(tx: Tx, ctx: AuthContext, input: unknown): Promise<UpdateJobResult> {
  const p = parseInput(UpdateJobInput, input);
  const { job, ref } = await loadVisibleJob(tx, ctx, p.jobId);
  assertMayEditSomeField(ctx, ref);
  assertVersion(job, p.expectedVersion);
  const { jobId: _jobId, expectedVersion: _version, ...fields } = p;
  void _jobId;
  void _version;
  return await applyJobFieldChanges(tx, ctx, job, ref, fields);
}

async function updateOne(tx: Tx, ctx: AuthContext, jobId: string, expectedVersion: number, fields: JobFieldsValue): Promise<UpdateJobResult> {
  const { job, ref } = await loadVisibleJob(tx, ctx, jobId);
  assertMayEditSomeField(ctx, ref);
  assertVersion(job, expectedVersion);
  return await applyJobFieldChanges(tx, ctx, job, ref, fields);
}

export async function setPriority(tx: Tx, ctx: AuthContext, input: unknown): Promise<UpdateJobResult> {
  const p = parseInput(SetPriorityInput, input);
  return await updateOne(tx, ctx, p.jobId, p.expectedVersion, { priority: p.priority });
}

/** Civil date (stored as end of that day in the org timezone), ISO instant, or null. */
export async function setDueDate(tx: Tx, ctx: AuthContext, input: unknown): Promise<UpdateJobResult> {
  const p = parseInput(SetDateInput, input);
  return await updateOne(tx, ctx, p.jobId, p.expectedVersion, { dueDate: p.value });
}

export async function setReviewDueDate(tx: Tx, ctx: AuthContext, input: unknown): Promise<UpdateJobResult> {
  const p = parseInput(SetDateInput, input);
  return await updateOne(tx, ctx, p.jobId, p.expectedVersion, { reviewDueDate: p.value });
}

export async function setDeliveryDueDate(tx: Tx, ctx: AuthContext, input: unknown): Promise<UpdateJobResult> {
  const p = parseInput(SetDateInput, input);
  return await updateOne(tx, ctx, p.jobId, p.expectedVersion, { deliveryDueDate: p.value });
}

export async function setShootDate(tx: Tx, ctx: AuthContext, input: unknown): Promise<UpdateJobResult> {
  const p = parseInput(SetDateInput, input);
  return await updateOne(tx, ctx, p.jobId, p.expectedVersion, { shootDate: p.value });
}

export async function setCompletionPercent(tx: Tx, ctx: AuthContext, input: unknown): Promise<UpdateJobResult> {
  const p = parseInput(SetCompletionPercentInput, input);
  return await updateOne(tx, ctx, p.jobId, p.expectedVersion, { completionPercent: p.completionPercent });
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

/** Editor (or an admin on behalf) pauses work while in an EDITOR_WORKING status; closes the running timer. */
export async function pauseJob(tx: Tx, ctx: AuthContext, input: unknown): Promise<PauseResult> {
  const p = parseInput(PauseInput, input);
  const { job: loaded, ref } = await loadVisibleJob(tx, ctx, p.jobId);
  assertCan(ctx, "job.pause", ref);
  assertVersion(loaded, p.expectedVersion);
  if (loaded.isPaused) throw new ValidationError("Work on this job is already paused");
  const closedSessionIds = await closeRunningSessions(tx, ctx, { jobId: loaded.id }, "paused", "user");
  const job = await updateJobRow(tx, ctx, loaded, { isPaused: true, pausedAt: ctx.now() });
  const onBehalfOf = isAdmin(ctx) && !ctx.isSystem && job.editorId && job.editorId !== ctx.userId ? job.editorId : undefined;
  const eventId = await recordEvent(tx, ctx, {
    entityType: "job",
    entityId: job.id,
    jobId: job.id,
    eventType: "job.paused",
    action: "paused",
    previousValue: { isPaused: false },
    newValue: { isPaused: true },
    metadata: jobEventMeta(job, { sessionId: closedSessionIds[0] ?? null, reason: p.reason ?? null, ...(onBehalfOf ? { onBehalfOf } : {}) }),
  });
  await notify(tx, ctx, {
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

export async function resumeJob(tx: Tx, ctx: AuthContext, input: unknown): Promise<PauseResult> {
  const p = parseInput(PauseInput, input);
  const { job: loaded, ref } = await loadVisibleJob(tx, ctx, p.jobId);
  assertCan(ctx, "job.pause", ref);
  assertVersion(loaded, p.expectedVersion);
  if (!loaded.isPaused) throw new ValidationError("Work on this job is not paused");
  const job = await updateJobRow(tx, ctx, loaded, { isPaused: false, pausedAt: null });
  const onBehalfOf = isAdmin(ctx) && !ctx.isSystem && job.editorId && job.editorId !== ctx.userId ? job.editorId : undefined;
  const eventId = await recordEvent(tx, ctx, {
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
export async function bulkSetPriority(ctx: AuthContext, input: unknown, options: { db?: Db } = {}): Promise<BulkResult> {
  const p = parseInput(BulkPriorityInput, input);
  return runPerJob(
    p.jobIds,
    async (tx, jobId, batchId) => {
      const { job, ref } = await loadVisibleJob(tx, ctx, jobId);
      await applyJobFieldChanges(tx, ctx, job, ref, { priority: p.priority }, { batchId });
    },
    { ...options, organisationId: ctx.organisationId },
  );
}

/** `POST /api/jobs/bulk/transition` — one tx per job through the workflow engine. */
export async function bulkTransition(ctx: AuthContext, input: unknown, options: { db?: Db } = {}): Promise<BulkResult> {
  const p = parseInput(BulkTransitionInput, input);
  return runPerJob(
    p.jobIds,
    async (tx, jobId, batchId) => {
      await transitionLoadedJob(tx, ctx, jobId, { toStatusId: p.toStatusId, toCategory: p.toCategory }, { reason: p.reason, override: p.override, batchId });
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
export async function recomputeJobDerived(tx: Tx, jobId: string, ctxIn?: AuthContext): Promise<RecomputeResult> {
  const job = await first(tx.select().from(jobs).where(eq(jobs.id, jobId)));
  if (!job || (ctxIn && ctxIn.organisationId !== job.organisationId)) throw new NotFoundError("Job");
  const ctx: AuthContext = ctxIn ? { ...ctxIn, cause: "recompute" } : await systemContext(job.organisationId, { db: tx, cause: "recompute" });

  const derived: Partial<Record<keyof Job, unknown>> = {};
  const open = await tx
    .select()
    .from(jobStatusTransitions)
    .where(and(eq(jobStatusTransitions.jobId, job.id), isNull(jobStatusTransitions.exitedAt)))
    .orderBy(asc(jobStatusTransitions.sequence));
  if (open.length !== 1) {
    throw new ValidationError(`Job ${job.jobNumber} has ${open.length} open stages; the transition ledger needs manual repair`);
  }
  const stage = open[0];
  const status = await first(tx.select().from(workflowStatuses).where(eq(workflowStatuses.id, stage.toStatusId)));
  if (!status) throw new NotFoundError("Status");
  derived.statusId = stage.toStatusId;
  derived.workflowId = status.workflowId;
  derived.statusCategory = status.category;
  derived.previousStatusId = stage.fromStatusId ?? null;
  derived.statusEnteredAt = stage.enteredAt;
  derived.completedAt = stage.toCategory === "completed" ? stage.enteredAt : null;
  derived.cancelledAt = stage.toCategory === "cancelled" ? stage.enteredAt : null;

  const openAssignment = async (role: "photographer" | "editor"): Promise<string | null> =>
    (
      await first(
        tx
          .select({ userId: jobAssignments.userId })
          .from(jobAssignments)
          .where(and(eq(jobAssignments.jobId, job.id), eq(jobAssignments.role, role), isNull(jobAssignments.unassignedAt)))
          .orderBy(desc(jobAssignments.rowid))
          .limit(1),
      )
    )?.userId ?? null;
  derived.photographerId = await openAssignment("photographer");
  derived.editorId = await openAssignment("editor");
  derived.previousEditorId =
    (
      await first(
        tx
          .select({ userId: jobAssignments.userId })
          .from(jobAssignments)
          .where(and(eq(jobAssignments.jobId, job.id), eq(jobAssignments.role, "editor"), isNotNull(jobAssignments.unassignedAt)))
          .orderBy(desc(jobAssignments.unassignedAt), desc(jobAssignments.assignedAt), desc(jobAssignments.rowid))
          .limit(1),
      )
    )?.userId ?? null;

  derived.revisionCount =
    (
      await first(
        tx
          .select({ n: sql<number>`coalesce(max(${jobRevisions.revisionNumber}), 0)`.mapWith(Number) })
          .from(jobRevisions)
          .where(eq(jobRevisions.jobId, job.id)),
      )
    )?.n ?? 0;
  derived.openRevisionId =
    (
      await first(
        tx
          .select({ id: jobRevisions.id })
          .from(jobRevisions)
          .where(and(eq(jobRevisions.jobId, job.id), isNull(jobRevisions.resolvedAt)))
          .orderBy(asc(jobRevisions.revisionNumber))
          .limit(1),
      )
    )?.id ?? null;
  derived.reopenedCount =
    (
      await first(
        tx
          .select({ n: count() })
          .from(jobStatusTransitions)
          .where(and(eq(jobStatusTransitions.jobId, job.id), eq(jobStatusTransitions.isReopen, true))),
      )
    )?.n ?? 0;
  if (job.isPaused && !CATEGORY_GROUPS.EDITOR_WORKING.includes(status.category)) {
    derived.isPaused = false;
    derived.pausedAt = null;
  }
  const lastEvent = (
    await first(
      tx
        .select({ at: sql<string | null>`max(${activityEvents.createdAt})` })
        .from(activityEvents)
        .where(eq(activityEvents.jobId, job.id)),
    )
  )?.at;
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
  await tx.update(jobs)
    .set({ ...(patch as Partial<typeof jobs.$inferInsert>), version: job.version + 1, updatedAt: now })
    .where(eq(jobs.id, job.id));
  for (const c of changes) {
    if (c.column === "lastActivityAt") continue; // audit exemption (§5)
    await recordEvent(tx, ctx, {
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
  const fresh: Job = await one(tx.select().from(jobs).where(eq(jobs.id, job.id)), "job");
  return { jobId: job.id, job: fresh, changes };
}

/** `POST /api/jobs/:id/recompute` — owner-only repair (`system.integrity`). */
export async function repairJob(tx: Tx, ctx: AuthContext, input: unknown): Promise<RecomputeResult> {
  assertCan(ctx, "system.integrity");
  const p = parseInput(JobIdInput, input);
  const { job } = await loadVisibleJob(tx, ctx, p.jobId);
  return await recomputeJobDerived(tx, job.id, ctx);
}

/** True when the actor may edit any job field (UI helper). */
export function canEditJobFields(ctx: AuthContext, ref: JobPermissionRef): boolean {
  return can(ctx, "job.edit_fields", ref);
}
