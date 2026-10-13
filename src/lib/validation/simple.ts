/**
 * Zod inputs for the simplified job actions (docs/SIMPLIFICATION-PLAN.md §5, §6, §8;
 * services/simple.ts). Every schema is strict: unknown keys are a 400, so no screen can smuggle
 * `sharedWithClient`, a status id or a priority through these composite actions.
 */
import { z } from "zod";
import { APPROVE_SHARE_CHOICES, SIMPLE_CHANGE_CHIPS, SIMPLE_REOPEN_REASONS } from "@/lib/constants";
import { ExpectedVersionSchema as OptionalExpectedVersionSchema } from "./admin-shared";
import { ExpectedVersionSchema, IdSchema, ReasonSchema } from "./jobs";
import { LinkLabelSchema, LinkUrlSchema } from "./links";
import { SetUsualCapacityInput } from "./users";
import { UsualDaysSchema } from "./workflow";

const Note = z.string().trim().max(5000);

/** Assign editor (stage Needs editor → With editor; the engine skips "Ready"). */
export const AssignEditorSimpleInput = z.strictObject({
  jobId: IdSchema,
  editorId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
});
export type AssignEditorSimpleInputValue = z.output<typeof AssignEditorSimpleInput>;

/**
 * The "Finished photos link" box (plan §5): any http(s) URL counts (a shared-drive folder included) and
 * is recorded as kind `finished_files`, superseding the previous finished link; `reuseCurrent` is the
 * "I updated the same link" tick and keeps the current one.
 */
export const FinishedLinkInput = z.union([
  z.strictObject({ url: LinkUrlSchema, label: LinkLabelSchema.nullish() }),
  z.strictObject({ reuseCurrent: z.literal(true) }),
]);
export type FinishedLinkInputValue = z.output<typeof FinishedLinkInput>;

/** Send for checking (With editor / Changes asked → Ready to check). REQUIRES a finished link (plan §9 "stricter"). */
export const SendForCheckingInput = z.strictObject({
  jobId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  finishedLink: FinishedLinkInput,
  /** Shown to the checker as the resolution note of a Changes-asked round. */
  note: Note.nullish(),
});
export type SendForCheckingInputValue = z.output<typeof SendForCheckingInput>;

/**
 * Approve (plan §5, decisions 2 + 3): `share` is "send" (Approve & send: approve → deliver with sharing →
 * complete), "only" (Approve only: stop at Approved, "Not sent to client") or "n/a" (the client has no
 * portal: approve → complete). `confirmSelfApproval` is the owner's "You edited this yourself" check.
 */
export const ApproveJobInput = z.strictObject({
  jobId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  share: z.enum(APPROVE_SHARE_CHOICES),
  confirmSelfApproval: z.boolean().optional(),
  /** Current links to make client-visible with "send" (default: the finished / gallery / download links the checker may share). */
  shareLinkIds: z.array(IdSchema).max(50).optional(),
});
export type ApproveJobInputValue = z.output<typeof ApproveJobInput>;

/** Ask for changes: one required box, optional chips, "Needed back by" (civil date; default tomorrow). */
export const AskForChangesInput = z.strictObject({
  jobId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  note: z.string().trim().min(1, "Say what needs changing").max(5000),
  chips: z.array(z.string().trim().min(1).max(40)).max(SIMPLE_CHANGE_CHIPS.length * 2).optional(),
  neededBy: z.iso.date().nullish(),
});
export type AskForChangesInputValue = z.output<typeof AskForChangesInput>;

/** Reopen a Done job (plan §5 ⋯ menu): two reasons. */
export const ReopenJobSimpleInput = z
  .strictObject({
    jobId: IdSchema,
    expectedVersion: ExpectedVersionSchema,
    reason: z.enum(SIMPLE_REOPEN_REASONS),
    note: Note.nullish(),
    /** "Fix the delivery link": the replacement client-visible link (required for that reason). */
    newLink: z.strictObject({ url: LinkUrlSchema, label: LinkLabelSchema.nullish() }).optional(),
  })
  .refine((v) => v.reason !== "fix_delivery_link" || v.newLink !== undefined, {
    message: "Paste the new delivery link",
    path: ["newLink"],
  });
export type ReopenJobSimpleInputValue = z.output<typeof ReopenJobSimpleInput>;

/** Editor's "Can't do this one": a reason is required; the job goes back to Needs editor. */
export const DeclineJobSimpleInput = z.strictObject({
  jobId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  reason: ReasonSchema,
});

/** Owner / photographer: "Take back from editor" (→ Needs editor). */
export const TakeBackFromEditorInput = z.strictObject({
  jobId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  reason: Note.nullish(),
});

/** Owner / photographer: "Change editor". */
export const ChangeEditorInput = z.strictObject({
  jobId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  editorId: IdSchema,
  reason: Note.nullish(),
});

/** Cancel job (reason required) / Restore. */
export const CancelJobSimpleInput = z.strictObject({ jobId: IdSchema, expectedVersion: ExpectedVersionSchema, reason: ReasonSchema });
export const RestoreJobSimpleInput = z.strictObject({ jobId: IdSchema, expectedVersion: ExpectedVersionSchema, reason: Note.nullish() });

/** Settings → Studio → Advanced tools (admin). `expectedVersion` = the organisation_settings row version. */
export const SetAdvancedToolsInput = z.strictObject({
  enabled: z.boolean(),
  expectedVersion: OptionalExpectedVersionSchema,
});
export type SetAdvancedToolsInputValue = z.output<typeof SetAdvancedToolsInput>;

/** Editors page: "Usually handles up to N" per editor (admin). */
export const SetEditorUsualCapacityInput = SetUsualCapacityInput;

/** Settings → Types of shoot: usual days to edit (admin). */
export const SetJobTypeUsualDaysInput = z.strictObject({
  jobTypeId: IdSchema,
  usualDaysToEdit: UsualDaysSchema,
  expectedVersion: OptionalExpectedVersionSchema,
});

/** "Close delivered jobs" (plan §9): owner-confirmed, one recorded completion per job. */
export const CloseDeliveredJobsInput = z.strictObject({ confirm: z.literal(true) });

/** "Mark old updates as read" (plan §8) and the "Proofline got simpler" card take no input. */
export const EmptyInput = z.strictObject({}).optional();
