/** POST /api/jobs/:id/cancel { expectedVersion, toStatusId?, reason? } - any active -> cancelled (reason required) */
import { mutateById } from "@/app/api/_lib/route";
import { cancelJob } from "@/server/services/workflow";

export const POST = mutateById("jobId", cancelJob);
