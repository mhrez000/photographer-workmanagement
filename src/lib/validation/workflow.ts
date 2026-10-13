/**
 * Zod inputs for workflow administration and job types (ARCHITECTURE.md §4.6).
 * Graph-level rules (one initial, required categories, reachability, …) live in
 * `validateWorkflowDefinition` (src/lib/workflow.ts); these schemas cover the
 * shape of each individual edit.
 */
import { z } from "zod";
import { STATUS_CATEGORIES } from "@/lib/constants";
import { AllowedRolesSchema } from "./json";
import { ExpectedVersionSchema, HexColourSchema, IdSchema, NameSchema, OptionalTextSchema } from "./admin-shared";

/** Status keys: stable lowercase slugs (same pattern validateWorkflowDefinition checks). */
export const StatusKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, "Use a lowercase slug (a-z, 0-9, _), starting with a letter");

/* ---------------- workflows ---------------- */

export const CreateWorkflowInput = z
  .object({
    name: NameSchema(120),
    description: OptionalTextSchema(1000),
    /** "default" = the built-in template, "workflow" = copy `sourceWorkflowId`, "blank" = required statuses only. */
    from: z.enum(["default", "workflow", "blank"]).default("default"),
    sourceWorkflowId: IdSchema.optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((v) => v.from !== "workflow" || !!v.sourceWorkflowId, {
    path: ["sourceWorkflowId"],
    message: "Choose a workflow to copy",
  });
export type CreateWorkflowInput = z.infer<typeof CreateWorkflowInput>;

export const UpdateWorkflowInput = z.object({
  workflowId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  name: NameSchema(120).optional(),
  description: OptionalTextSchema(1000),
  /** Only `true` is accepted: make this the organisation default (unsets the previous one). */
  isDefault: z.literal(true).optional(),
});
export type UpdateWorkflowInput = z.infer<typeof UpdateWorkflowInput>;

export const ArchiveWorkflowInput = z.object({ workflowId: IdSchema, expectedVersion: ExpectedVersionSchema });
export type ArchiveWorkflowInput = z.infer<typeof ArchiveWorkflowInput>;

/* ---------------- statuses ---------------- */

export const AddStatusInput = z.object({
  workflowId: IdSchema,
  name: NameSchema(80),
  /** Omitted → derived from the name. */
  key: StatusKeySchema.optional(),
  category: z.enum(STATUS_CATEGORIES),
  colour: HexColourSchema.optional(),
  description: OptionalTextSchema(500),
  /** Omitted → after the last status. */
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  isInitial: z.boolean().optional(),
});
export type AddStatusInput = z.infer<typeof AddStatusInput>;

export const UpdateStatusInput = z.object({
  statusId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  name: NameSchema(80).optional(),
  category: z.enum(STATUS_CATEGORIES).optional(),
  colour: HexColourSchema.optional(),
  description: OptionalTextSchema(500),
  /** Only `true`: make this the initial status (must be category "new"). */
  isInitial: z.literal(true).optional(),
});
export type UpdateStatusInput = z.infer<typeof UpdateStatusInput>;

export const ArchiveStatusInput = z.object({ statusId: IdSchema, expectedVersion: ExpectedVersionSchema });
export type ArchiveStatusInput = z.infer<typeof ArchiveStatusInput>;

export const ReorderStatusesInput = z.object({
  workflowId: IdSchema,
  /** Every non-archived status of the workflow, in the new order. */
  statusIds: z.array(IdSchema).min(1).max(200),
});
export type ReorderStatusesInput = z.infer<typeof ReorderStatusesInput>;

/* ---------------- transitions ---------------- */

const TransitionFlags = {
  label: OptionalTextSchema(80),
  allowedRoles: AllowedRolesSchema,
  requiresAssignedEditor: z.boolean().optional(),
  assigneeOnly: z.boolean().optional(),
  isReopen: z.boolean().optional(),
};

export const AddTransitionInput = z
  .object({
    workflowId: IdSchema,
    fromStatusId: IdSchema,
    toStatusId: IdSchema,
    ...TransitionFlags,
  })
  .refine((v) => v.fromStatusId !== v.toStatusId, { path: ["toStatusId"], message: "A transition must change the status" });
export type AddTransitionInput = z.infer<typeof AddTransitionInput>;

export const UpdateTransitionInput = z.object({
  transitionId: IdSchema,
  label: TransitionFlags.label,
  allowedRoles: AllowedRolesSchema.optional(),
  requiresAssignedEditor: z.boolean().optional(),
  assigneeOnly: z.boolean().optional(),
  isReopen: z.boolean().optional(),
});
export type UpdateTransitionInput = z.infer<typeof UpdateTransitionInput>;

export const ArchiveTransitionInput = z.object({ transitionId: IdSchema });
export type ArchiveTransitionInput = z.infer<typeof ArchiveTransitionInput>;

/* ---------------- job types ---------------- */

const HoursSchema = z.number().min(0).max(500).nullable();
/** "Usual days to edit" of a type of shoot (SIMPLIFICATION-PLAN §5: due date = shoot date + N); null = unset (→ 1). */
export const UsualDaysSchema = z.number().int().min(0).max(365).nullable();

export const CreateJobTypeInput = z.object({
  name: NameSchema(80),
  colour: HexColourSchema.optional(),
  /** Omitted → the organisation's default workflow. */
  workflowId: IdSchema.optional(),
  defaultEstimatedHours: HoursSchema.optional(),
  usualDaysToEdit: UsualDaysSchema.optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
export type CreateJobTypeInput = z.infer<typeof CreateJobTypeInput>;

export const UpdateJobTypeInput = z.object({
  jobTypeId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  name: NameSchema(80).optional(),
  colour: HexColourSchema.optional(),
  /** Affects new jobs only (jobs.workflow_id is a snapshot). */
  workflowId: IdSchema.optional(),
  defaultEstimatedHours: HoursSchema.optional(),
  usualDaysToEdit: UsualDaysSchema.optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
export type UpdateJobTypeInput = z.infer<typeof UpdateJobTypeInput>;

export const JobTypeIdInput = z.object({ jobTypeId: IdSchema, expectedVersion: ExpectedVersionSchema });
export type JobTypeIdInput = z.infer<typeof JobTypeIdInput>;
