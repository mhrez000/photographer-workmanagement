/** POST /api/jobs/:id/complete { expectedVersion, toStatusId?, reason? } - approved / delivered -> completed */
import { mutateById } from "@/app/api/_lib/route";
import { completeJob } from "@/server/services/workflow";

export const POST = mutateById("jobId", completeJob);
