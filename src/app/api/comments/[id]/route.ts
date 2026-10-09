/** PATCH /api/comments/:id { body } (author, edit window); DELETE /api/comments/:id (soft) */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { deleteComment, editComment } from "@/server/services/comments";

export const PATCH = mutateById("commentId", editComment);
export const DELETE = mutateById("commentId", deleteComment, { withQuery: true });

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["PATCH", "DELETE"]);
export const POST = methodNotAllowed(["PATCH", "DELETE"]);
export const PUT = methodNotAllowed(["PATCH", "DELETE"]);
