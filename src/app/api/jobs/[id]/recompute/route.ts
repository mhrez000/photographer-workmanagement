/** POST /api/jobs/:id/recompute - owner-only repair of derived columns -> RecomputeResult */
import { mutateById } from "@/app/api/_lib/route";
import { repairJob } from "@/server/services/jobs";

export const POST = mutateById("jobId", repairJob);
