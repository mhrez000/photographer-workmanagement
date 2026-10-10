/**
 * Client portal writes (docs/ROLES.md §7.5, §7.7). Thin portal gates in front
 * of the real services — they never write rows themselves:
 *
 * - Feedback: the job must be in the client's portal (`portalJobsWhere`,
 *   else 404), the comment must be the client's own `client_feedback` (else
 *   404), a reply must sit in a thread started by the client's own company
 *   (else 404). Feedback writes then go through `services/comments.ts`
 *   (`addComment` / `editComment` / `deleteComment`), which owns the
 *   comment rows, the audit events and the staff notifications.
 * - Profile: `updateUser` on self (name only).
 * - Notification preferences: `setNotificationPrefs` restricted to the three
 *   client notification types.
 *
 * Every function runs inside the caller's transaction (route: one tx).
 */
import { and, eq } from "drizzle-orm";
import { first, type DbLike, type Tx } from "@/db/index";
import { jobComments, users } from "@/db/schema";
import { CLIENT_NOTIFICATION_TYPES } from "@/lib/constants";
import type { AuthContext, PortalFeedbackMessage } from "@/lib/types";
import {
  PortalFeedbackDeleteInput,
  PortalFeedbackEditInput,
  PortalFeedbackInput,
  PortalNotificationPrefsInput,
  PortalProfileInput,
} from "@/lib/validation/portal";
import { assertCan } from "@/server/auth/permissions";
import { NotFoundError, UnauthorizedError } from "@/server/errors";
import { loadPortalJob } from "@/server/queries/portal";
import { addComment, deleteComment, editComment } from "./comments";
import { getNotificationPrefs, setNotificationPrefs, updateUser, type NotificationPrefView } from "./users";
import { loadCommentInOrg, parseInput } from "./_shared";

function clientUserId(ctx: AuthContext): string {
  assertCan(ctx, "portal.access");
  if (!ctx.userId || !ctx.clientId) throw new UnauthorizedError();
  return ctx.userId;
}

async function authorOf(tx: Tx, organisationId: string, userId: string): Promise<{ name: string; role: string; clientId: string | null } | undefined> {
  return first(
    tx
      .select({ name: users.name, role: users.role, clientId: users.clientId })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.organisationId, organisationId))),
  );
}

/** The client-safe shape of a feedback message the client just wrote or changed. */
async function toMessage(
  tx: Tx,
  ctx: AuthContext,
  c: { id: string; authorUserId: string; body: string; createdAt: string; editedAt: string | null; deletedAt: string | null },
): Promise<PortalFeedbackMessage> {
  const author = await authorOf(tx, ctx.organisationId, c.authorUserId);
  const deleted = c.deletedAt !== null;
  return {
    id: c.id,
    body: deleted ? "" : c.body,
    authorName: author?.name ?? "",
    isClient: author?.role === "client",
    createdAt: c.createdAt,
    editedAt: deleted ? null : c.editedAt,
    deleted,
  };
}

/**
 * A comment the client may act on: a `client_feedback` comment on a job in
 * their portal whose thread was started by a user of their client. Anything
 * else is 404 (no oracle for staff comments or other clients' threads).
 */
async function loadClientThreadComment(tx: Tx, ctx: AuthContext, commentId: string) {
  const comment = await loadCommentInOrg(tx, ctx, commentId);
  if (comment.kind !== "client_feedback") throw new NotFoundError("Comment");
  const { ref } = await loadPortalJob(tx, ctx, comment.jobId);
  const rootId = comment.rootCommentId ?? comment.id;
  const root =
    rootId === comment.id
      ? comment
      : await first(
          tx
            .select({ id: jobComments.id, kind: jobComments.kind, authorUserId: jobComments.authorUserId, jobId: jobComments.jobId })
            .from(jobComments)
            .where(and(eq(jobComments.id, rootId), eq(jobComments.organisationId, ctx.organisationId))),
        );
  if (!root || root.kind !== "client_feedback" || root.jobId !== comment.jobId) throw new NotFoundError("Comment");
  const rootAuthor = await authorOf(tx, ctx.organisationId, root.authorUserId);
  if (!rootAuthor || rootAuthor.role !== "client" || rootAuthor.clientId !== ctx.clientId) throw new NotFoundError("Comment");
  return { comment, ref };
}

/** POST /api/portal/jobs/:id/feedback — a new thread or a reply in one of the client's threads. */
export async function postPortalFeedback(tx: Tx, ctx: AuthContext, input: unknown): Promise<PortalFeedbackMessage> {
  clientUserId(ctx);
  const data = parseInput(PortalFeedbackInput, input);
  const { ref } = await loadPortalJob(tx, ctx, data.jobId);
  if (data.parentCommentId) {
    const { comment } = await loadClientThreadComment(tx, ctx, data.parentCommentId);
    if (comment.jobId !== ref.id) throw new NotFoundError("Comment");
  }
  assertCan(ctx, "portal.give_feedback", ref);
  const result = await addComment(tx, ctx, {
    jobId: ref.id,
    body: data.body,
    kind: "client_feedback",
    parentCommentId: data.parentCommentId ?? null,
    mentionUserIds: [],
  });
  return toMessage(tx, ctx, result.comment);
}

/** PATCH /api/portal/comments/:id — own feedback, within the edit window, while feedback is on. */
export async function editPortalFeedback(tx: Tx, ctx: AuthContext, input: unknown): Promise<PortalFeedbackMessage> {
  const me = clientUserId(ctx);
  const data = parseInput(PortalFeedbackEditInput, input);
  const { comment, ref } = await loadClientThreadComment(tx, ctx, data.commentId);
  if (comment.authorUserId !== me || comment.deletedAt) throw new NotFoundError("Comment");
  assertCan(ctx, "portal.give_feedback", ref);
  const updated = await editComment(tx, ctx, { commentId: comment.id, body: data.body });
  return toMessage(tx, ctx, updated);
}

/** DELETE /api/portal/comments/:id — soft-deletes own feedback. */
export async function deletePortalFeedback(tx: Tx, ctx: AuthContext, input: unknown): Promise<PortalFeedbackMessage> {
  const me = clientUserId(ctx);
  const data = parseInput(PortalFeedbackDeleteInput, input);
  const { comment } = await loadClientThreadComment(tx, ctx, data.commentId);
  if (comment.authorUserId !== me) throw new NotFoundError("Comment");
  const updated = await deleteComment(tx, ctx, { commentId: comment.id });
  return toMessage(tx, ctx, updated);
}

export interface PortalProfile {
  name: string;
  email: string;
  version: number;
}

/** PATCH /api/portal/me { name } — the portal account's display name. */
export async function updatePortalProfile(tx: Tx, ctx: AuthContext, input: unknown): Promise<PortalProfile> {
  const me = clientUserId(ctx);
  const data = parseInput(PortalProfileInput, input);
  const user = await updateUser(tx, ctx, { userId: me, name: data.name, ...(data.expectedVersion !== undefined ? { expectedVersion: data.expectedVersion } : {}) });
  return { name: user.name, email: user.email, version: user.version };
}

const CLIENT_TYPES: ReadonlySet<string> = new Set(CLIENT_NOTIFICATION_TYPES);

/** GET /api/portal/notification-prefs — the three client types only. */
export async function getPortalNotificationPrefs(db: DbLike, ctx: AuthContext): Promise<NotificationPrefView[]> {
  clientUserId(ctx);
  return (await getNotificationPrefs(db, ctx)).filter((p) => CLIENT_TYPES.has(p.type));
}

/** PUT /api/portal/notification-prefs { prefs } — staff types are rejected by the strict schema (400). */
export async function setPortalNotificationPrefs(tx: Tx, ctx: AuthContext, input: unknown): Promise<NotificationPrefView[]> {
  clientUserId(ctx);
  const data = parseInput(PortalNotificationPrefsInput, input);
  const prefs = await setNotificationPrefs(tx, ctx, { prefs: data.prefs });
  return prefs.filter((p) => CLIENT_TYPES.has(p.type));
}
