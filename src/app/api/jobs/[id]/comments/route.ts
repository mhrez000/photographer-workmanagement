/** GET /api/jobs/:id/comments -> CommentNode[]; POST { body, parentCommentId?, kind?, revisionId?, mentionUserIds[] } */
import { mutateById, readBy } from "@/app/api/_lib/route";
import { addComment, listComments } from "@/server/services/comments";

export const GET = readBy((db, ctx, id) => listComments(db, ctx, id));
export const POST = mutateById("jobId", addComment);
