/** PATCH /api/comments/:id { body } (author, edit window); DELETE /api/comments/:id (soft) */
import { mutateById } from "@/app/api/_lib/route";
import { deleteComment, editComment } from "@/server/services/comments";

export const PATCH = mutateById("commentId", editComment);
export const DELETE = mutateById("commentId", deleteComment, { withQuery: true });
