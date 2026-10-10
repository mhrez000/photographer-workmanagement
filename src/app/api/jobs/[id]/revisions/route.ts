/** GET /api/jobs/:id/revisions -> { revisions, openRevision }; POST (= transition -> revision) { reason, description, instructions?, priority?, dueDate?, assigneeUserId?, expectedVersion, toStatusId? } */
import { mutateById, readBy, methodNotAllowed } from "@/app/api/_lib/route";
import { getJobDetail } from "@/server/queries/jobDetail";
import { requestRevision } from "@/server/services/revisions";

export const GET = readBy(async (db, ctx, id) => {
  const detail = await getJobDetail(db, ctx, id);
  return { revisions: detail.revisions, openRevision: detail.openRevision };
});
export const POST = mutateById("jobId", requestRevision);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const PUT = methodNotAllowed(["GET", "POST"]);
export const PATCH = methodNotAllowed(["GET", "POST"]);
export const DELETE = methodNotAllowed(["GET", "POST"]);
