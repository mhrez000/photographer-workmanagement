/**
 * Zod schemas for the job / workflow / assignment services (ARCHITECTURE.md §4, §9).
 *
 * Services parse `unknown` input with these (via `parseInput` from
 * services/_shared.ts); route handlers and server actions never validate.
 *
 * Dates: every deadline accepts a civil date `YYYY-MM-DD` (the UI date picker)
 * or a full ISO-8601 instant. Services convert with `deadlineToIso()`: a civil
 * date becomes the LAST millisecond of that day in the organisation timezone
 * (so `civilDate()` of the stored instant is the picked day), an ISO instant
 * is normalised to UTC `…Z`. `null` clears the date.
 */
import { z } from "zod";
import { EVENT_CAUSES, PRIORITIES, STATUS_CATEGORIES, UNASSIGN_REASONS } from "@/lib/constants";
import { endOfCivilDayIso } from "@/lib/dates";

/* ------------------------------------------------------------------ */
/*  Primitives                                                         */
/* ------------------------------------------------------------------ */

export const IdSchema = z.string().trim().min(1, "Required").max(64);
export const ExpectedVersionSchema = z.number().int().positive();
export const PrioritySchema = z.enum(PRIORITIES);
export const StatusCategorySchema = z.enum(STATUS_CATEGORIES);
export const ReasonSchema = z.string().trim().min(1, "Required").max(2000);

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A civil date (YYYY-MM-DD) or an ISO-8601 instant with offset. */
export const DateInputSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
export const NullableDateSchema = DateInputSchema.nullable();

/**
 * Converts a validated date input to the stored ISO instant.
 * Civil date → last millisecond of that civil day in `timeZone`
 * (`endOfCivilDayIso`). ISO instant → normalised UTC string.
 */
export function deadlineToIso(value: string, timeZone: string): string {
  if (CIVIL_DATE.test(value)) return endOfCivilDayIso(value, timeZone);
  return new Date(value).toISOString();
}

/** `deadlineToIso` that passes `null` / `undefined` through. */
export function optionalDeadlineToIso(value: string | null | undefined, timeZone: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return deadlineToIso(value, timeZone);
}

const EstimatedHoursSchema = z.number().min(0).max(1000).nullable();

/* ------------------------------------------------------------------ */
/*  Revision payload (shared by transition + revisions service)        */
/* ------------------------------------------------------------------ */

/** Payload required when entering a `revision` status (§4.3 step 5). */
export const RevisionInput = z.object({
  /** Free text; suggestions in REVISION_REASON_SUGGESTIONS. */
  reason: z.string().trim().min(1, "Required").max(200),
  description: z.string().trim().min(1, "Required").max(5000),
  instructions: z.string().trim().max(5000).nullish(),
  priority: PrioritySchema.optional(),
  dueDate: NullableDateSchema.optional(),
  /** Editor expected to resolve it; defaults to the job's current editor. */
  assigneeUserId: IdSchema.nullish(),
  /**
   * "Turn into revision request" (docs/ROLES.md §7.5): the client_feedback thread
   * this request quotes. Needs `client_feedback.to_revision`; stored as
   * `revision.requested` metadata.fromFeedbackCommentId.
   */
  fromFeedbackCommentId: IdSchema.optional(),
});
export type RevisionInputValue = z.output<typeof RevisionInput>;

/* ------------------------------------------------------------------ */
/*  Delivery step (docs/ROLES.md §7.3)                                 */
/* ------------------------------------------------------------------ */

/**
 * Optional payload of a DELIVERING move (→ delivered, or → completed while the
 * job was never delivered). `shareJob` shares the job with its client;
 * `shareLinkIds` (current links of this job, any kind) replace the default
 * share set (current gallery / client_delivery links added by someone who
 * could share). Sent on any other move → 422.
 */
export const DeliveryInput = z.strictObject({
  shareJob: z.boolean().optional(),
  shareLinkIds: z.array(IdSchema).max(50).optional(),
});
export type DeliveryInputValue = z.output<typeof DeliveryInput>;

/* ------------------------------------------------------------------ */
/*  Jobs                                                               */
/* ------------------------------------------------------------------ */

/** Inline "New project" from the New job form (docs/ROLES.md §4.3), under an existing client. */
export const InlineProjectInput = z.strictObject({
  name: z.string().trim().min(1, "Required").max(200),
  address: z.string().trim().max(500).nullish(),
});

/**
 * Strict (docs/ROLES.md §3.5): sharing columns (`sharedWithClient`, …) and any
 * other unknown key → 400. Exactly one of `projectId` / `newProject`
 * (`newProject` needs `clientId`).
 */
export const CreateJobInput = z
  .strictObject({
    name: z.string().trim().min(1, "Required").max(200),
    description: z.string().trim().max(5000).nullish(),
    projectId: IdSchema.optional(),
    /** Created in the same transaction under `clientId` (needs `project.create`). */
    newProject: InlineProjectInput.optional(),
    /** Optional with `projectId` (must equal the project's client); required with `newProject`. */
    clientId: IdSchema.optional(),
    jobTypeId: IdSchema,
    priority: PrioritySchema.optional(),
    /**
     * Admins: any active photographer (omitted → self; null → none). Team members:
     * themselves only. Editors: required; omitted → the org's default photographer.
     */
    photographerId: IdSchema.nullish(),
    /**
     * Optional initial editor → the job moves to `assigned` in the same transaction.
     * Editors: only themselves ("Assign to me", checked with `job.claim`) or none.
     */
    editorId: IdSchema.nullish(),
    shootDate: NullableDateSchema.optional(),
    dueDate: NullableDateSchema.optional(),
    reviewDueDate: NullableDateSchema.optional(),
    deliveryDueDate: NullableDateSchema.optional(),
    estimatedHours: EstimatedHoursSchema.optional(),
  })
  .refine((v) => (v.projectId ? 1 : 0) + (v.newProject ? 1 : 0) === 1, {
    message: "Choose a project or create a new one",
    path: ["projectId"],
  })
  .refine((v) => !v.newProject || v.clientId !== undefined, {
    message: "Choose the client of the new project",
    path: ["clientId"],
  });
export type CreateJobInputValue = z.output<typeof CreateJobInput>;

/** Fields `updateJob` accepts (each checked against its own permission). Strict (§3.5). */
export const JobFieldsSchema = z.strictObject({
  name: z.string().trim().min(1, "Required").max(200).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  clientId: IdSchema.optional(),
  projectId: IdSchema.optional(),
  jobTypeId: IdSchema.optional(),
  shootDate: NullableDateSchema.optional(),
  estimatedHours: EstimatedHoursSchema.optional(),
  priority: PrioritySchema.optional(),
  dueDate: NullableDateSchema.optional(),
  reviewDueDate: NullableDateSchema.optional(),
  deliveryDueDate: NullableDateSchema.optional(),
  completionPercent: z.number().int().min(0).max(100).optional(),
});
export type JobFieldsValue = z.output<typeof JobFieldsSchema>;

export const UpdateJobInput = JobFieldsSchema.extend({
  jobId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
}).refine((v) => Object.keys(v).some((k) => k !== "jobId" && k !== "expectedVersion"), {
  message: "Nothing to update",
});
export type UpdateJobInputValue = z.output<typeof UpdateJobInput>;

export const SetPriorityInput = z.object({ jobId: IdSchema, expectedVersion: ExpectedVersionSchema, priority: PrioritySchema });
export const SetDateInput = z.object({ jobId: IdSchema, expectedVersion: ExpectedVersionSchema, value: NullableDateSchema });
export const SetCompletionPercentInput = z.object({
  jobId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  completionPercent: z.number().int().min(0).max(100),
});
export const PauseInput = z.object({ jobId: IdSchema, expectedVersion: ExpectedVersionSchema, reason: z.string().trim().max(2000).nullish() });
export const JobIdInput = z.object({ jobId: IdSchema });

/** `POST /api/jobs/:id/claim` — an editor takes an unassigned job they created (draft window open). */
export const ClaimJobInput = z.strictObject({ jobId: IdSchema, expectedVersion: ExpectedVersionSchema });

/** `POST /api/jobs/:id/share { shared, expectedVersion }` (`job.share_with_client`). */
export const ShareJobInput = z.strictObject({ jobId: IdSchema, shared: z.boolean(), expectedVersion: ExpectedVersionSchema });

/* ------------------------------------------------------------------ */
/*  Transitions                                                        */
/* ------------------------------------------------------------------ */

export const TransitionInput = z
  .object({
    jobId: IdSchema,
    toStatusId: IdSchema.optional(),
    toCategory: StatusCategorySchema.optional(),
    expectedVersion: ExpectedVersionSchema,
    reason: z.string().trim().max(2000).nullish(),
    /** Owner/manager escape hatch (any → any); reason required. */
    override: z.boolean().optional(),
    /** Required when the target is a revision status. */
    revision: RevisionInput.optional(),
    /** Start the actor's timer when entering an editing status (time tracking on). */
    startTimer: z.boolean().optional(),
    /** Delivering moves only (docs/ROLES.md §7.3). */
    delivery: DeliveryInput.optional(),
    /** Honoured for system contexts only (automation / sweep / seed). */
    cause: z.enum(EVENT_CAUSES).optional(),
  })
  .refine((v) => (v.toStatusId ? 1 : 0) + (v.toCategory ? 1 : 0) === 1, {
    message: "Give exactly one of toStatusId or toCategory",
    path: ["toStatusId"],
  });
export type TransitionInputValue = z.output<typeof TransitionInput>;

/** Input of the thin wrappers (accept / start / submit / approve / …): the category is implied. */
export const CategoryMoveInput = z.object({
  jobId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  /** Picks one status when the category has several (e.g. "Rough Cut" / "Final Cut"). */
  toStatusId: IdSchema.optional(),
  reason: z.string().trim().max(2000).nullish(),
  startTimer: z.boolean().optional(),
  /** Deliver / complete only (docs/ROLES.md §7.3); 422 on any other move. */
  delivery: DeliveryInput.optional(),
});
export type CategoryMoveInputValue = z.output<typeof CategoryMoveInput>;

/** Reopen a completed job: target category defaults to in_progress. */
export const ReopenInput = CategoryMoveInput.extend({
  toCategory: z.enum(["in_progress", "revision", "approved"]).optional(),
  reason: ReasonSchema,
  revision: RevisionInput.optional(),
});

/** Cancel: reason required. */
export const CancelInput = CategoryMoveInput.extend({ reason: ReasonSchema });

export const RestoreInput = z.object({ jobId: IdSchema, expectedVersion: ExpectedVersionSchema, reason: z.string().trim().max(2000).nullish() });

export const MigrateWorkflowInput = z.object({
  jobId: IdSchema,
  workflowId: IdSchema,
  toStatusId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  reason: z.string().trim().max(2000).nullish(),
});

/* ------------------------------------------------------------------ */
/*  Assignments                                                        */
/* ------------------------------------------------------------------ */

/**
 * `expectedVersion` is optional here: omitted → no version check. Internal
 * callers (user deactivation, bulk) assign on a freshly loaded job; route
 * handlers should always pass it.
 */
export const AssignEditorInput = z.object({
  jobId: IdSchema,
  /** null = unassign. */
  userId: IdSchema.nullable(),
  /** Free text stored on the assignment. "user_deactivated" also sets that unassign reason. */
  reason: z.string().trim().max(2000).nullish(),
  /** Reason recorded on the CLOSED assignment row (default reassigned / unassigned). */
  unassignReason: z.enum(UNASSIGN_REASONS).optional(),
  expectedVersion: ExpectedVersionSchema.optional(),
});
export type AssignEditorInputValue = z.output<typeof AssignEditorInput>;

export const AssignPhotographerInput = AssignEditorInput;

export const UnassignEditorInput = z.object({
  jobId: IdSchema,
  /** Accepted for symmetry with assignEditor; must be null when given. */
  userId: z.null().optional(),
  reason: z.string().trim().max(2000).nullish(),
  unassignReason: z.enum(UNASSIGN_REASONS).optional(),
  expectedVersion: ExpectedVersionSchema.optional(),
});

/** `POST /api/jobs/:id/assign { role, userId | null, reason }`. */
export const AssignInput = AssignEditorInput.extend({ role: z.enum(["editor", "photographer"]) });

/* ------------------------------------------------------------------ */
/*  Bulk (one transaction per job, no expectedVersion)                 */
/* ------------------------------------------------------------------ */

export const BulkJobIdsSchema = z.array(IdSchema).min(1, "Select at least one job").max(200);

export const BulkReassignInput = z.object({
  jobIds: BulkJobIdsSchema,
  userId: IdSchema.nullable(),
  reason: z.string().trim().max(2000).nullish(),
});
export const BulkPriorityInput = z.object({ jobIds: BulkJobIdsSchema, priority: PrioritySchema });
export const BulkTransitionInput = z
  .object({
    jobIds: BulkJobIdsSchema,
    toStatusId: IdSchema.optional(),
    toCategory: StatusCategorySchema.optional(),
    reason: z.string().trim().max(2000).nullish(),
    override: z.boolean().optional(),
  })
  .refine((v) => (v.toStatusId ? 1 : 0) + (v.toCategory ? 1 : 0) === 1, {
    message: "Give exactly one of toStatusId or toCategory",
    path: ["toStatusId"],
  });
/** Generic bulk input shape (exported for route handlers / UI typing). */
export const BulkInput = z.object({ jobIds: BulkJobIdsSchema });
