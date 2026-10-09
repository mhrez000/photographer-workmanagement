/**
 * Zod schemas for the revisions service (ARCHITECTURE.md §2.4, §4.4, §9 Revisions).
 * The revision payload itself (`RevisionInput`) lives in ./jobs because the
 * generic transition input embeds it; it is re-exported here.
 */
import { z } from "zod";
import { ExpectedVersionSchema, IdSchema, NullableDateSchema, PrioritySchema, RevisionInput } from "./jobs";

export { RevisionInput, type RevisionInputValue } from "./jobs";

/** `POST /api/jobs/:id/revisions` = transition → revision with the payload. */
export const RequestRevisionInput = RevisionInput.extend({
  jobId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  /** Picks one revision status when the workflow has several. */
  toStatusId: IdSchema.optional(),
});
export type RequestRevisionInputValue = z.output<typeof RequestRevisionInput>;

/** `PATCH /api/revisions/:id` — only while the revision is open. */
export const UpdateRevisionInput = z
  .object({
    revisionId: IdSchema,
    assigneeUserId: IdSchema.nullable().optional(),
    instructions: z.string().trim().max(5000).nullable().optional(),
    priority: PrioritySchema.optional(),
    dueDate: NullableDateSchema.optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== "revisionId"), { message: "Nothing to update" });
export type UpdateRevisionInputValue = z.output<typeof UpdateRevisionInput>;

/** `POST /api/revisions/:id/resolve` = transition → resubmitted. `expectedVersion` is the JOB version. */
export const ResolveRevisionInput = z.object({
  revisionId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  note: z.string().trim().max(5000).nullish(),
  toStatusId: IdSchema.optional(),
});

/** `POST /api/revisions/:id/withdraw` — back to the status the revision was requested from. */
export const WithdrawRevisionInput = z.object({
  revisionId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  note: z.string().trim().max(5000).nullish(),
});
