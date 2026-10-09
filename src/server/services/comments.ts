/**
 * Job comments (ARCHITECTURE.md §2.4 job_comments / comment_mentions, §3.2
 * comment rows, §5 comment.* events, §6 comment_added / mentioned).
 *
 * - Threads: a root comment gets a pre-generated id so `root_comment_id = id`
 *   is set at insert (immutable afterwards); replies inherit the parent's root.
 * - @mentions are explicit user ids. Every target must be active, in the
 *   organisation AND pass `job.view` for the job; otherwise the whole comment
 *   is rejected with `InvalidMentionError` (422) listing the names (unknown or
 *   foreign ids are counted, never named — no existence leak).
 * - Edits: author only, within COMMENT_EDIT_WINDOW_MINUTES; stamps
 *   `edited_at` and bumps `edit_count` (the jc_guard trigger demands both).
 * - Delete is soft (fill-once `deleted_at/by`); the body is retained and the
 *   thread renders a placeholder.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DbLike, Tx } from "@/db/index";
import { commentMentions, jobComments, users } from "@/db/schema";
import type { AuthContext, CommentNode, JobComment, JobPermissionRef } from "@/lib/types";
import { newId } from "@/lib/ids";
import { AddCommentInput, DeleteCommentInput, EditCommentInput } from "@/lib/validation/comments";
import { assertCan, can, type CommentPermissionRef } from "@/server/auth/permissions";
import { recordEvent } from "@/server/audit";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { jobMeta, loadJobWithRef, loadUserRefMap, unknownUserRef, userCanViewJob } from "./_collab";
import { loadCommentInOrg, loadRevisionInOrg, parseInput } from "./_shared";
import { jobParticipants, notify } from "./notifications";

/* ------------------------------------------------------------------ */
/*  Errors                                                             */
/* ------------------------------------------------------------------ */

export interface InvalidMentionDetails {
  /** Ids rejected (only ids that resolve to users of the actor's org). */
  invalidUserIds: string[];
  /** Display names of the rejected in-org users. */
  names: string[];
  /** Ids that do not resolve to anyone in the organisation (never named). */
  unknownCount: number;
}

/** 422 — one or more mention targets cannot see the job (or are inactive / unknown). */
export class InvalidMentionError extends ValidationError {
  override readonly status: number = 422;
  readonly mention: InvalidMentionDetails;
  constructor(details: InvalidMentionDetails) {
    const parts = [...details.names];
    if (details.unknownCount > 0) parts.push(details.unknownCount === 1 ? "1 unknown user" : `${details.unknownCount} unknown users`);
    super(`These people can't be mentioned on this job: ${parts.join(", ")}`, details);
    this.mention = details;
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const SNIPPET_LENGTH = 140;

function snippet(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_LENGTH ? `${flat.slice(0, SNIPPET_LENGTH - 1)}…` : flat;
}

function commentLink(jobId: string, commentId: string): string {
  return `/jobs/${jobId}?tab=comments#comment-${commentId}`;
}

function commentRef(ref: JobPermissionRef, c: JobComment): CommentPermissionRef {
  return { job: ref, authorUserId: c.authorUserId, createdAt: c.createdAt, deletedAt: c.deletedAt };
}

/**
 * Validates mention targets: active, in-org, and able to view the job.
 * Returns the deduplicated ids with their names; throws InvalidMentionError.
 */
function validateMentions(tx: Tx, ctx: AuthContext, ref: JobPermissionRef, ids: readonly string[]): { id: string; name: string }[] {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return [];
  const rows = tx
    .select({ id: users.id, name: users.name, isActive: users.isActive })
    .from(users)
    .where(and(inArray(users.id, unique), eq(users.organisationId, ctx.organisationId)))
    .all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const invalidUserIds: string[] = [];
  const names: string[] = [];
  let unknownCount = 0;
  const valid: { id: string; name: string }[] = [];
  for (const id of unique) {
    const row = byId.get(id);
    if (!row) {
      unknownCount += 1;
      continue;
    }
    if (!row.isActive || !userCanViewJob(tx, ctx, id, ref)) {
      invalidUserIds.push(id);
      names.push(row.name);
      continue;
    }
    valid.push({ id: row.id, name: row.name });
  }
  if (invalidUserIds.length > 0 || unknownCount > 0) throw new InvalidMentionError({ invalidUserIds, names, unknownCount });
  return valid;
}

/* ------------------------------------------------------------------ */
/*  addComment                                                         */
/* ------------------------------------------------------------------ */

export interface AddCommentResult {
  comment: JobComment;
  mentionUserIds: string[];
  /** comment.added event id. */
  eventId: string;
  /** Users who received a comment_added or mentioned notification. */
  notifiedUserIds: string[];
}

/**
 * Posts a comment (root or reply). Permission: `comment.add` on the job
 * (+ `comment.mention` when mentioning). Writes the comment, its mention
 * rows, `comment.added` + one `comment.mentioned` per mention, and the
 * notifications, all in `tx`.
 */
export function addComment(tx: Tx, ctx: AuthContext, input: unknown): AddCommentResult {
  const data = parseInput(AddCommentInput, input);
  const { job, ref } = loadJobWithRef(tx, ctx, data.jobId);
  assertCan(ctx, "comment.add", ref);
  if (data.mentionUserIds.length > 0) assertCan(ctx, "comment.mention", ref);
  if (!ctx.userId) throw new ValidationError("Comments need an author");
  const authorUserId = ctx.userId;

  // Thread placement.
  let parentCommentId: string | null = null;
  let rootCommentId: string | null = null;
  if (data.parentCommentId) {
    const parent = loadCommentInOrg(tx, ctx, data.parentCommentId);
    if (parent.jobId !== job.id) throw new NotFoundError("Comment");
    if (parent.deletedAt) throw new ValidationError("You can't reply to a deleted comment");
    parentCommentId = parent.id;
    rootCommentId = parent.rootCommentId ?? parent.id;
  }

  // Revision reference.
  let revisionId: string | null = null;
  if (data.revisionId) {
    const revision = loadRevisionInOrg(tx, ctx, data.revisionId);
    if (revision.jobId !== job.id) throw new NotFoundError("Revision");
    revisionId = revision.id;
  } else if (data.kind === "revision_response") {
    if (!job.openRevisionId) {
      throw new ValidationError("There is no open revision to respond to", {
        formErrors: [],
        fieldErrors: { revisionId: ["There is no open revision to respond to"] },
      });
    }
    revisionId = job.openRevisionId;
  }

  const mentions = validateMentions(tx, ctx, ref, data.mentionUserIds);

  const id = newId();
  const createdAt = ctx.now();
  const comment = tx
    .insert(jobComments)
    .values({
      id,
      organisationId: ctx.organisationId,
      jobId: job.id,
      parentCommentId,
      rootCommentId: rootCommentId ?? id,
      revisionId,
      authorUserId,
      kind: data.kind,
      body: data.body,
      createdAt,
    })
    .returning()
    .get();

  if (mentions.length > 0) {
    tx.insert(commentMentions)
      .values(mentions.map((m) => ({ organisationId: ctx.organisationId, commentId: id, mentionedUserId: m.id, createdAt })))
      .run();
  }

  const mentionUserIds = mentions.map((m) => m.id);
  const eventId = recordEvent(tx, ctx, {
    entityType: "comment",
    entityId: id,
    jobId: job.id,
    eventType: "comment.added",
    action: "created",
    previousValue: null,
    newValue: {
      body: comment.body,
      kind: comment.kind,
      parentCommentId: comment.parentCommentId,
      rootCommentId: comment.rootCommentId,
      revisionId: comment.revisionId,
      mentionUserIds,
    },
    metadata: { commentId: id, ...jobMeta(job) },
  });

  const linkPath = commentLink(job.id, id);
  const notified = new Set<string>();

  // Mentions: one event each, feeding a (mandatory) `mentioned` notification.
  for (const m of mentions) {
    const mentionEventId = recordEvent(tx, ctx, {
      entityType: "comment",
      entityId: id,
      jobId: job.id,
      eventType: "comment.mentioned",
      action: "mentioned",
      previousValue: null,
      newValue: { mentionedUserId: m.id, mentionedUserName: m.name },
      metadata: { commentId: id, ...jobMeta(job) },
    });
    const res = notify(tx, ctx, {
      userIds: [m.id],
      type: "mentioned",
      title: `You were mentioned on ${job.jobNumber}`,
      body: snippet(comment.body),
      jobId: job.id,
      activityEventId: mentionEventId,
      linkPath,
    });
    res.recipientIds.forEach((r) => notified.add(r));
  }

  // comment_added: photographer, editor, creator + previous commenters in this thread
  // (mentioned users already got their own notification).
  const participants = jobParticipants(tx, job.id, { rootCommentId: comment.rootCommentId ?? id });
  const mentioned = new Set(mentionUserIds);
  const candidates = Array.from(
    new Set(
      [participants.photographerId, participants.editorId, participants.createdByUserId, ...participants.commenterIds].filter(
        (u): u is string => typeof u === "string" && u !== authorUserId && !mentioned.has(u),
      ),
    ),
  ).filter((u) => userCanViewJob(tx, ctx, u, ref));
  if (candidates.length > 0) {
    const res = notify(tx, ctx, {
      userIds: candidates,
      type: "comment_added",
      title: parentCommentId ? `New reply on ${job.jobNumber}` : `New comment on ${job.jobNumber}`,
      body: snippet(comment.body),
      jobId: job.id,
      activityEventId: eventId,
      linkPath,
    });
    res.recipientIds.forEach((r) => notified.add(r));
  }

  return { comment, mentionUserIds, eventId, notifiedUserIds: Array.from(notified) };
}

/* ------------------------------------------------------------------ */
/*  editComment / deleteComment                                        */
/* ------------------------------------------------------------------ */

/**
 * Edits the body. Permission `comment.edit`: author only, within
 * COMMENT_EDIT_WINDOW_MINUTES of posting, not deleted. An unchanged body is
 * a no-op (no event, no edit_count bump).
 */
export function editComment(tx: Tx, ctx: AuthContext, input: unknown): JobComment {
  const data = parseInput(EditCommentInput, input);
  const existing = loadCommentInOrg(tx, ctx, data.commentId);
  const { job, ref } = loadJobWithRef(tx, ctx, existing.jobId);
  assertCan(ctx, "comment.edit", commentRef(ref, existing));
  if (data.body === existing.body) return existing;

  const editedAt = ctx.now();
  const updated = tx
    .update(jobComments)
    .set({ body: data.body, editedAt, editCount: existing.editCount + 1 })
    .where(and(eq(jobComments.id, existing.id), eq(jobComments.editCount, existing.editCount)))
    .returning()
    .get();
  if (!updated) {
    throw new ConflictError(undefined, loadCommentInOrg(tx, ctx, existing.id));
  }

  recordEvent(tx, ctx, {
    entityType: "comment",
    entityId: existing.id,
    jobId: job.id,
    eventType: "comment.edited",
    action: "updated",
    previousValue: { body: existing.body },
    newValue: { body: updated.body },
    metadata: { commentId: existing.id, editCount: updated.editCount, ...jobMeta(job) },
  });
  return updated;
}

/**
 * Soft-deletes a comment (fill-once `deleted_at/by`; body retained).
 * Permission `comment.delete`: owners/managers any, others their own.
 * Deleting an already-deleted comment is a no-op.
 */
export function deleteComment(tx: Tx, ctx: AuthContext, input: unknown): JobComment {
  const data = parseInput(DeleteCommentInput, input);
  const existing = loadCommentInOrg(tx, ctx, data.commentId);
  const { job, ref } = loadJobWithRef(tx, ctx, existing.jobId);
  assertCan(ctx, "job.view", ref);
  if (existing.deletedAt) return existing;
  assertCan(ctx, "comment.delete", commentRef(ref, existing));

  const deletedAt = ctx.now();
  const updated = tx
    .update(jobComments)
    .set({ deletedAt, deletedByUserId: ctx.userId })
    .where(and(eq(jobComments.id, existing.id), eq(jobComments.organisationId, ctx.organisationId)))
    .returning()
    .get();
  if (!updated) throw new NotFoundError("Comment");

  recordEvent(tx, ctx, {
    entityType: "comment",
    entityId: existing.id,
    jobId: job.id,
    eventType: "comment.deleted",
    action: "soft_deleted",
    previousValue: { body: existing.body },
    newValue: null,
    metadata: { commentId: existing.id, ...jobMeta(job) },
  });
  return updated;
}

/* ------------------------------------------------------------------ */
/*  listComments                                                       */
/* ------------------------------------------------------------------ */

/**
 * The job's comment threads as a tree (roots oldest first, replies nested
 * under their parent, oldest first). Deleted comments stay in place with
 * `body: null` and no mentions (placeholder). Permission: `job.view`.
 */
export function listComments(db: DbLike, ctx: AuthContext, jobId: string): CommentNode[] {
  const { job, ref } = loadJobWithRef(db, ctx, jobId);
  assertCan(ctx, "job.view", ref);

  const rows = db
    .select()
    .from(jobComments)
    .where(and(eq(jobComments.jobId, job.id), eq(jobComments.organisationId, ctx.organisationId)))
    .orderBy(asc(jobComments.createdAt), asc(jobComments.id))
    .all();
  if (rows.length === 0) return [];

  const mentionRows = db
    .select({ commentId: commentMentions.commentId, userId: commentMentions.mentionedUserId })
    .from(commentMentions)
    .where(
      and(
        eq(commentMentions.organisationId, ctx.organisationId),
        inArray(
          commentMentions.commentId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .all();
  const mentionsByComment = new Map<string, string[]>();
  for (const m of mentionRows) {
    const list = mentionsByComment.get(m.commentId) ?? [];
    list.push(m.userId);
    mentionsByComment.set(m.commentId, list);
  }

  const people = loadUserRefMap(db, ctx, [...rows.map((r) => r.authorUserId), ...mentionRows.map((m) => m.userId)]);
  const person = (id: string) => people.get(id) ?? unknownUserRef(id);

  const nodes = new Map<string, CommentNode>();
  for (const row of rows) {
    const deleted = row.deletedAt !== null;
    nodes.set(row.id, {
      id: row.id,
      parentCommentId: row.parentCommentId,
      rootCommentId: row.rootCommentId ?? row.id,
      revisionId: row.revisionId,
      author: person(row.authorUserId),
      kind: row.kind,
      body: deleted ? null : row.body,
      mentions: deleted ? [] : (mentionsByComment.get(row.id) ?? []).map(person),
      editedAt: row.editedAt,
      editCount: row.editCount,
      deletedAt: row.deletedAt,
      createdAt: row.createdAt,
      canEdit: can(ctx, "comment.edit", commentRef(ref, row)),
      replies: [],
    });
  }

  const roots: CommentNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id);
    if (!node) continue;
    const parent = row.parentCommentId ? nodes.get(row.parentCommentId) : undefined;
    if (parent) parent.replies.push(node);
    else roots.push(node);
  }
  return roots;
}
