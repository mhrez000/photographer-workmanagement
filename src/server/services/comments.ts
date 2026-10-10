/**
 * Job comments (ARCHITECTURE.md §2.4 job_comments / comment_mentions, §3.2
 * comment rows, §5 comment.* events, §6 comment_added / mentioned; roles v2:
 * docs/ROLES.md §3.3 ‡, §6.4, §7.5).
 *
 * - Threads: a root comment gets a pre-generated id so `root_comment_id = id`
 *   is set at insert (immutable afterwards); replies inherit the parent's root.
 * - Kinds: staff write `STAFF_COMMENT_KINDS`. `client_feedback` threads are
 *   STARTED by client users (portal) and answered by staff with
 *   `client_feedback.reply`; a reply's kind equals its root's kind when the
 *   root is `client_feedback`, and a staff thread never contains
 *   `client_feedback` replies (422). @mentions are rejected in client threads.
 * - @mentions are explicit user ids. Every target must be active, in the
 *   organisation AND pass `job.view` for the job (clients never do); otherwise
 *   the whole comment is rejected with `InvalidMentionError` (422) listing the
 *   names (unknown or foreign ids are counted, never named — no existence leak).
 * - Edits: author only, within COMMENT_EDIT_WINDOW_MINUTES; stamps
 *   `edited_at` and bumps `edit_count` (the jc_guard trigger demands both).
 * - Delete is soft (fill-once `deleted_at/by`); the body is retained and the
 *   thread renders a placeholder.
 * - Client users (portal) reach these functions through services/portal.ts;
 *   their job is resolved through the portal rules (`portal.view_job`, else 404).
 * - Notifications: staff reply in a client thread → `client_feedback_reply` to the
 *   client's portal users; client post → `client_feedback` to the photographer,
 *   a photographer creator and every admin; editor questions → photographer,
 *   photographer creator, and all admins when neither of them can review.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { first, one, type DbLike, type Tx } from "@/db/index";

import { commentMentions, jobComments, users } from "@/db/schema";
import { QUESTION_COMMENT_KINDS, STAFF_COMMENT_KINDS, type CommentKind } from "@/lib/constants";
import type { AuthContext, CommentNode, Job, JobComment, JobPermissionRef } from "@/lib/types";
import { newId } from "@/lib/ids";
import { AddCommentInput, DeleteCommentInput, EditCommentInput } from "@/lib/validation/comments";
import { assertCan, can, isClient, type CommentPermissionRef } from "@/server/auth/permissions";
import { loadJobRef } from "@/server/auth/job-ref";
import { buildContextFromDb } from "@/server/auth/session";
import { recordEvent } from "@/server/audit";
import { ConflictError, ForbiddenError, NotFoundError, RuleViolationError, ValidationError } from "@/server/errors";
import { editorReadCutoff, loadEditorAssignmentFacts, passesCutoff } from "@/server/queries/scope";
import { jobMeta, loadJobWithRef, loadUserRefMap, unknownUserRef, userCanViewJob } from "./_collab";
import { loadCommentInOrg, loadRevisionInOrg, parseInput } from "./_shared";
import { adminsOf, jobParticipants, notify } from "./notifications";
import { clientPortalUserIds, isClientVisible } from "./sharing";

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

/** 422 — the comment kind does not fit the thread (client threads, §7.5): a well-formed request that breaks a thread rule. */
export class ThreadKindError extends RuleViolationError {
  constructor(message: string) {
    super(message, { formErrors: [], fieldErrors: { kind: [message] } });
  }
}

function threadKindError(message: string): ValidationError {
  return new ThreadKindError(message);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const SNIPPET_LENGTH = 140;
const STAFF_KINDS: readonly CommentKind[] = STAFF_COMMENT_KINDS;
const QUESTION_KINDS: readonly CommentKind[] = QUESTION_COMMENT_KINDS;

function snippet(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_LENGTH ? `${flat.slice(0, SNIPPET_LENGTH - 1)}…` : flat;
}

function commentLink(jobId: string, commentId: string): string {
  return `/jobs/${jobId}?tab=comments#comment-${commentId}`;
}

function commentRef(ref: JobPermissionRef, c: JobComment, rootKind: CommentKind): CommentPermissionRef {
  return { job: ref, authorUserId: c.authorUserId, createdAt: c.createdAt, deletedAt: c.deletedAt, kind: c.kind, rootKind };
}

/** The thread root of `c` (itself for roots). */
async function rootOf(db: DbLike, ctx: AuthContext, c: JobComment): Promise<JobComment> {
  const rootId = c.rootCommentId ?? c.id;
  if (rootId === c.id) return c;
  const root = await first(
    db
      .select()
      .from(jobComments)
      .where(and(eq(jobComments.id, rootId), eq(jobComments.organisationId, ctx.organisationId))),
  );
  if (!root || root.jobId !== c.jobId) throw new NotFoundError("Comment");
  return root;
}

/** The client a user belongs to (client users only). */
async function clientIdOfUser(db: DbLike, ctx: AuthContext, userId: string): Promise<string | null> {
  const row = await first(
    db
      .select({ role: users.role, clientId: users.clientId })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.organisationId, ctx.organisationId))),
  );
  return row && row.role === "client" ? row.clientId : null;
}

/**
 * The job of a comment action: staff through `job.view` (404 otherwise); client
 * users through the portal rules (`portal.view_job`, 404 otherwise).
 */
async function loadJobForComments(db: DbLike, ctx: AuthContext, jobId: string): Promise<{ job: Job; ref: JobPermissionRef }> {
  if (!isClient(ctx)) return loadJobWithRef(db, ctx, jobId);
  const { job, ref } = await loadJobRef(db, ctx, jobId);
  if (!can(ctx, "portal.view_job", ref)) throw new NotFoundError("Job");
  return { job, ref };
}

/**
 * A client may act only on `client_feedback` threads started by a user of
 * their own client (everything else is 404: no oracle for staff comments or
 * another client's thread).
 */
async function assertOwnClientThread(db: DbLike, ctx: AuthContext, root: JobComment): Promise<void> {
  if (root.kind !== "client_feedback") throw new NotFoundError("Comment");
  const rootClient = await clientIdOfUser(db, ctx, root.authorUserId);
  if (rootClient === null || rootClient !== ctx.clientId) throw new NotFoundError("Comment");
}

/**
 * Validates mention targets: active, in-org, and able to view the job.
 * Returns the deduplicated ids with their names; throws InvalidMentionError.
 */
async function validateMentions(
  tx: Tx,
  ctx: AuthContext,
  ref: JobPermissionRef,
  ids: readonly string[],
): Promise<{ id: string; name: string }[]> {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return [];
  const rows = await tx
    .select({ id: users.id, name: users.name, isActive: users.isActive })
    .from(users)
    .where(and(inArray(users.id, unique), eq(users.organisationId, ctx.organisationId)));
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
    if (!row.isActive || !(await userCanViewJob(tx, ctx, id, ref))) {
      invalidUserIds.push(id);
      names.push(row.name);
      continue;
    }
    valid.push({ id: row.id, name: row.name });
  }
  if (invalidUserIds.length > 0 || unknownCount > 0) throw new InvalidMentionError({ invalidUserIds, names, unknownCount });
  return valid;
}

/** Whether `userId` could review this job (fresh context; inactive / foreign → false). */
async function userCanReview(db: DbLike, ctx: AuthContext, userId: string | null, ref: JobPermissionRef): Promise<boolean> {
  if (!userId) return false;
  const target = await buildContextFromDb(db, userId, { now: ctx.now, requestId: ctx.requestId });
  if (!target || target.organisationId !== ctx.organisationId) return false;
  return can(target, "job.begin_review", ref);
}

/**
 * Recipients of an editor question (§6.4): the job's photographer, its creator
 * when a photographer created it, and every admin when neither of them can
 * review. The asker is never a recipient.
 */
async function questionRecipients(db: DbLike, ctx: AuthContext, job: Job, ref: JobPermissionRef): Promise<string[]> {
  const creator = job.createdByRole === "photographer" ? job.createdByUserId : null;
  const out = new Set<string>([job.photographerId, creator].filter((id): id is string => typeof id === "string"));
  const reviewer = (await userCanReview(db, ctx, job.photographerId, ref)) || (await userCanReview(db, ctx, creator, ref));
  if (!reviewer) for (const id of await adminsOf(db, ctx.organisationId)) out.add(id);
  if (ctx.userId) out.delete(ctx.userId);
  return [...out];
}

/* ------------------------------------------------------------------ */
/*  addComment                                                         */
/* ------------------------------------------------------------------ */

export interface AddCommentResult {
  comment: JobComment;
  mentionUserIds: string[];
  /** comment.added event id. */
  eventId: string;
  /** Users who received a notification about it (any type). */
  notifiedUserIds: string[];
}

interface Placement {
  parentCommentId: string | null;
  rootCommentId: string | null;
  root: JobComment | null;
}

async function placeInThread(tx: Tx, ctx: AuthContext, jobId: string, parentCommentId: string | null | undefined): Promise<Placement> {
  if (!parentCommentId) return { parentCommentId: null, rootCommentId: null, root: null };
  const parent = await loadCommentInOrg(tx, ctx, parentCommentId);
  if (parent.jobId !== jobId) throw new NotFoundError("Comment");
  const root = await rootOf(tx, ctx, parent);
  if (isClient(ctx)) await assertOwnClientThread(tx, ctx, root);
  if (parent.deletedAt) throw new ValidationError("You can't reply to a deleted comment");
  return { parentCommentId: parent.id, rootCommentId: root.id, root };
}

/**
 * Posts a comment (root or reply). Staff: `comment.add` on the job
 * (+ `comment.mention` when mentioning; + `client_feedback.reply` for a reply in
 * a client thread). Client users: a `client_feedback` root or reply on a job of
 * their portal (`portal.give_feedback`). Writes the comment, its mention rows,
 * `comment.added` + one `comment.mentioned` per mention, and the notifications,
 * all in `tx`.
 */
export async function addComment(tx: Tx, ctx: AuthContext, input: unknown): Promise<AddCommentResult> {
  const data = parseInput(AddCommentInput, input);
  const client = isClient(ctx);
  const { job, ref } = await loadJobForComments(tx, ctx, data.jobId);
  if (!ctx.userId) throw new ValidationError("Comments need an author");
  const authorUserId = ctx.userId;

  if (client) {
    if (data.kind !== "client_feedback") throw new ForbiddenError("comment.add", "Clients can only leave feedback");
    if (data.mentionUserIds.length > 0) throw threadKindError("You can't mention people in feedback");
    if (data.revisionId) throw threadKindError("Feedback can't reference a revision");
  } else {
    assertCan(ctx, "comment.add", ref);
  }

  // Thread placement + kind consistency (§7.5).
  const placement = await placeInThread(tx, ctx, job.id, data.parentCommentId);
  const rootKind: CommentKind | null = placement.root?.kind ?? null;
  if (data.kind === "client_feedback") {
    if (client) {
      assertCan(ctx, "portal.give_feedback", ref);
    } else {
      if (rootKind !== "client_feedback") throw threadKindError("Client threads are started by the client; reply inside one");
      assertCan(ctx, "client_feedback.reply", ref);
      if (data.mentionUserIds.length > 0) throw threadKindError("Mentions are not allowed in client threads: the client sees every reply");
    }
  } else {
    if (!STAFF_KINDS.includes(data.kind)) throw threadKindError("Unknown comment kind");
    if (rootKind === "client_feedback") throw threadKindError("Replies in a client thread are visible to the client: reply as client feedback");
  }
  if (data.mentionUserIds.length > 0) assertCan(ctx, "comment.mention", ref);

  // Revision reference (staff threads only).
  let revisionId: string | null = null;
  if (data.revisionId) {
    const revision = await loadRevisionInOrg(tx, ctx, data.revisionId);
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

  const mentions = await validateMentions(tx, ctx, ref, data.mentionUserIds);

  const id = newId();
  const createdAt = ctx.now();
  const comment = await one(
    tx
      .insert(jobComments)
      .values({
        id,
        organisationId: ctx.organisationId,
        jobId: job.id,
        parentCommentId: placement.parentCommentId,
        rootCommentId: placement.rootCommentId ?? id,
        revisionId,
        authorUserId,
        kind: data.kind,
        body: data.body,
        createdAt,
      })
      .returning(),
    "comment",
  );

  if (mentions.length > 0) {
    await tx
      .insert(commentMentions)
      .values(mentions.map((m) => ({ organisationId: ctx.organisationId, commentId: id, mentionedUserId: m.id, createdAt })));
  }

  const mentionUserIds = mentions.map((m) => m.id);
  const eventId = await recordEvent(tx, ctx, {
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
    ...(comment.kind === "client_feedback" ? { visibility: "all" as const } : {}),
  });

  const linkPath = commentLink(job.id, id);
  const notified = new Set<string>();

  if (client) {
    // Client post → the people who answer it (§7.5); editors are not notified.
    const author = await first(tx.select({ name: users.name }).from(users).where(eq(users.id, authorUserId)));
    const res = await notify(tx, ctx, {
      userIds: [job.photographerId, job.createdByRole === "photographer" ? job.createdByUserId : null, ...(await adminsOf(tx, ctx.organisationId))],
      type: "client_feedback",
      title: `${author?.name ?? "The client"} left feedback on ${job.jobNumber}`,
      body: snippet(comment.body),
      jobId: job.id,
      activityEventId: eventId,
      linkPath,
    });
    res.recipientIds.forEach((r) => notified.add(r));
    return { comment, mentionUserIds, eventId, notifiedUserIds: Array.from(notified) };
  }

  // Mentions: one event each, feeding a (mandatory) `mentioned` notification.
  for (const m of mentions) {
    const mentionEventId = await recordEvent(tx, ctx, {
      entityType: "comment",
      entityId: id,
      jobId: job.id,
      eventType: "comment.mentioned",
      action: "mentioned",
      previousValue: null,
      newValue: { mentionedUserId: m.id, mentionedUserName: m.name },
      metadata: { commentId: id, ...jobMeta(job) },
    });
    const res = await notify(tx, ctx, {
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

  // Staff reply in a client thread → the client's portal users (§7.5), when the thread
  // belongs to the job's current client and the job is in their portal.
  if (comment.kind === "client_feedback" && placement.root) {
    const rootClient = await clientIdOfUser(tx, ctx, placement.root.authorUserId);
    if (rootClient !== null && rootClient === job.clientId && isClientVisible(job, ref)) {
      const res = await notify(tx, ctx, {
        userIds: await clientPortalUserIds(tx, ctx.organisationId, job.clientId),
        type: "client_feedback_reply",
        title: `The studio replied on ${job.name}`,
        body: snippet(comment.body),
        jobId: job.id,
        activityEventId: eventId,
        linkPath: `/portal/jobs/${job.id}`,
      });
      res.recipientIds.forEach((r) => notified.add(r));
    }
  }

  // comment_added: photographer, editor, creator + previous commenters in this thread
  // (mentioned users already got their own notification) + question routing (§6.4).
  const participants = await jobParticipants(tx, job.id, { rootCommentId: comment.rootCommentId ?? id });
  const mentioned = new Set(mentionUserIds);
  const question = QUESTION_KINDS.includes(comment.kind);
  const extra = question ? await questionRecipients(tx, ctx, job, ref) : [];
  const possible = Array.from(
    new Set(
      [participants.photographerId, participants.editorId, participants.createdByUserId, ...participants.commenterIds, ...extra].filter(
        (u): u is string => typeof u === "string" && u !== authorUserId && !mentioned.has(u),
      ),
    ),
  );
  const candidates: string[] = [];
  for (const u of possible) {
    if (await userCanViewJob(tx, ctx, u, ref)) candidates.push(u);
  }
  if (candidates.length > 0) {
    let title = placement.parentCommentId ? `New reply on ${job.jobNumber}` : `New comment on ${job.jobNumber}`;
    if (question) {
      const author = await first(tx.select({ name: users.name }).from(users).where(eq(users.id, authorUserId)));
      title = `Question from ${author?.name ?? "an editor"} on ${job.jobNumber}`;
    }
    const res = await notify(tx, ctx, {
      userIds: candidates,
      type: "comment_added",
      title,
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

/** The comment + its job for an edit/delete: client users only ever reach their own client thread comments. */
async function loadCommentForChange(tx: Tx, ctx: AuthContext, commentId: string): Promise<{ existing: JobComment; job: Job; ref: JobPermissionRef; rootKind: CommentKind }> {
  const existing = await loadCommentInOrg(tx, ctx, commentId);
  const { job, ref } = await loadJobForComments(tx, ctx, existing.jobId);
  const root = await rootOf(tx, ctx, existing);
  if (isClient(ctx)) {
    await assertOwnClientThread(tx, ctx, root);
    if (existing.kind !== "client_feedback" || existing.authorUserId !== ctx.userId) throw new NotFoundError("Comment");
  }
  return { existing, job, ref, rootKind: root.kind };
}

/**
 * Edits the body. Permission `comment.edit`: author only, within
 * COMMENT_EDIT_WINDOW_MINUTES of posting, not deleted (clients: their own
 * feedback while feedback is on). An unchanged body is a no-op (no event, no
 * edit_count bump).
 */
export async function editComment(tx: Tx, ctx: AuthContext, input: unknown): Promise<JobComment> {
  const data = parseInput(EditCommentInput, input);
  const { existing, job, ref, rootKind } = await loadCommentForChange(tx, ctx, data.commentId);
  assertCan(ctx, "comment.edit", commentRef(ref, existing, rootKind));
  if (data.body === existing.body) return existing;

  const editedAt = ctx.now();
  const updated = await first(
    tx
      .update(jobComments)
      .set({ body: data.body, editedAt, editCount: existing.editCount + 1 })
      .where(and(eq(jobComments.id, existing.id), eq(jobComments.editCount, existing.editCount)))
      .returning(),
  );
  if (!updated) {
    throw new ConflictError(undefined, await loadCommentInOrg(tx, ctx, existing.id));
  }

  await recordEvent(tx, ctx, {
    entityType: "comment",
    entityId: existing.id,
    jobId: job.id,
    eventType: "comment.edited",
    action: "updated",
    previousValue: { body: existing.body },
    newValue: { body: updated.body },
    metadata: { commentId: existing.id, editCount: updated.editCount, ...jobMeta(job) },
    ...(existing.kind === "client_feedback" ? { visibility: "all" as const } : {}),
  });
  return updated;
}

/**
 * Soft-deletes a comment (fill-once `deleted_at/by`; body retained).
 * Permission `comment.delete`: admins any, others their own (clients: their
 * own feedback). Deleting an already-deleted comment is a no-op.
 */
export async function deleteComment(tx: Tx, ctx: AuthContext, input: unknown): Promise<JobComment> {
  const data = parseInput(DeleteCommentInput, input);
  const { existing, job, ref, rootKind } = await loadCommentForChange(tx, ctx, data.commentId);
  if (existing.deletedAt) return existing;
  assertCan(ctx, "comment.delete", commentRef(ref, existing, rootKind));

  const deletedAt = ctx.now();
  const updated = await first(
    tx
      .update(jobComments)
      .set({ deletedAt, deletedByUserId: ctx.userId })
      .where(and(eq(jobComments.id, existing.id), eq(jobComments.organisationId, ctx.organisationId)))
      .returning(),
  );
  if (!updated) throw new NotFoundError("Comment");

  await recordEvent(tx, ctx, {
    entityType: "comment",
    entityId: existing.id,
    jobId: job.id,
    eventType: "comment.deleted",
    action: "soft_deleted",
    previousValue: { body: existing.body },
    newValue: null,
    metadata: { commentId: existing.id, ...jobMeta(job) },
    ...(existing.kind === "client_feedback" ? { visibility: "all" as const } : {}),
  });
  return updated;
}

/* ------------------------------------------------------------------ */
/*  listComments                                                       */
/* ------------------------------------------------------------------ */

/**
 * The job's comment threads as a tree (roots oldest first, replies nested
 * under their parent, oldest first). Deleted comments stay in place with
 * `body: null` and no mentions (placeholder). Permission: `job.view` (staff).
 * An editor whose only access is past/created sees comments up to their
 * read cut-off plus their own (docs/ROLES.md §2.3).
 */
export async function listComments(db: DbLike, ctx: AuthContext, jobId: string): Promise<CommentNode[]> {
  const { job, ref } = await loadJobWithRef(db, ctx, jobId);
  assertCan(ctx, "job.view", ref);

  const cutoff = editorReadCutoff(ctx, ref, (await loadEditorAssignmentFacts(db, ctx, [job.id])).get(job.id) ?? []);
  const rows = (
    await db
      .select()
      .from(jobComments)
      .where(and(eq(jobComments.jobId, job.id), eq(jobComments.organisationId, ctx.organisationId)))
      .orderBy(asc(jobComments.createdAt), asc(jobComments.id))
  ).filter((r) => passesCutoff(cutoff, r.createdAt, r.authorUserId, ctx.userId));
  if (rows.length === 0) return [];

  const mentionRows = await db
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
    .orderBy(asc(commentMentions.createdAt), asc(commentMentions.id));
  const mentionsByComment = new Map<string, string[]>();
  for (const m of mentionRows) {
    const list = mentionsByComment.get(m.commentId) ?? [];
    list.push(m.userId);
    mentionsByComment.set(m.commentId, list);
  }

  const people = await loadUserRefMap(db, ctx, [...rows.map((r) => r.authorUserId), ...mentionRows.map((m) => m.userId)]);
  const person = (id: string) => people.get(id) ?? unknownUserRef(id);
  const kindOf = new Map(rows.map((r) => [r.id, r.kind]));

  const nodes = new Map<string, CommentNode>();
  for (const row of rows) {
    const deleted = row.deletedAt !== null;
    const rootKind = kindOf.get(row.rootCommentId ?? row.id) ?? row.kind;
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
      canEdit: can(ctx, "comment.edit", commentRef(ref, row, rootKind)),
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
