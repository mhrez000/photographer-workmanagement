/** Zod schemas for job comments (ARCHITECTURE.md §2.4, §9 Comments). */
import { z } from "zod";
import { COMMENT_KINDS } from "@/lib/constants";

export const COMMENT_BODY_MAX = 10_000;
export const COMMENT_MAX_MENTIONS = 25;

const Id = z.string().trim().min(1).max(64);

export const CommentBodySchema = z
  .string({ error: "Write a comment" })
  .trim()
  .min(1, "Write a comment")
  .max(COMMENT_BODY_MAX, `Keep comments under ${COMMENT_BODY_MAX} characters`);

export const AddCommentInput = z.object({
  jobId: Id,
  body: CommentBodySchema,
  kind: z.enum(COMMENT_KINDS).default("comment"),
  parentCommentId: Id.nullish(),
  /** Respond-to-revision; defaults to the job's open revision for kind = revision_response. */
  revisionId: Id.nullish(),
  mentionUserIds: z.array(Id).max(COMMENT_MAX_MENTIONS, `Mention at most ${COMMENT_MAX_MENTIONS} people`).default([]),
});
export type AddCommentInput = z.input<typeof AddCommentInput>;

export const EditCommentInput = z.object({
  commentId: Id,
  body: CommentBodySchema,
});
export type EditCommentInput = z.input<typeof EditCommentInput>;

export const DeleteCommentInput = z.object({
  commentId: Id,
});
export type DeleteCommentInput = z.input<typeof DeleteCommentInput>;
