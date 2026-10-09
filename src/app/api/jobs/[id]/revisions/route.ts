/** GET /api/jobs/:id/revisions -> { revisions, openRevision }; POST (= transition -> revision) { reason, description, instructions?, priority?, dueDate?, assigneeUserId?, expectedVersion, toStatusId? } */
import { mutateById, readBy } from "@/app/api/_lib/route";
import { getJobDetail } from "@/server/queries/jobDetail";
import { requestRevision } from "@/server/services/revisions";

export const GET = readBy((db, ctx, id) => {
  const detail = getJobDetail(db, ctx, id);
  return { revisions: detail.revisions, openRevision: detail.openRevision };
});
export const POST = mutateById("jobId", requestRevision);
