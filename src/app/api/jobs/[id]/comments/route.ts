/** GET /api/jobs/:id/comments -> CommentNode[]; POST { body, parentCommentId?, kind?, revisionId?, mentionUserIds[] } */
import { mutateById, readBy, methodNotAllowed } from "@/app/api/_lib/route";
import { addComment, listComments } from "@/server/services/comments";

export const GET = readBy((db, ctx, id) => listComments(db, ctx, id));
export const POST = mutateById("jobId", addComment);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const PUT = methodNotAllowed(["GET", "POST"]);
export const PATCH = methodNotAllowed(["GET", "POST"]);
export const DELETE = methodNotAllowed(["GET", "POST"]);
