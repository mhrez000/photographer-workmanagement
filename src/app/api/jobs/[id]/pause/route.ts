/** POST /api/jobs/:id/pause { expectedVersion, toStatusId?, reason? } - pause editing ({ reason? }) */
import { mutateById } from "@/app/api/_lib/route";
import { pauseJob } from "@/server/services/jobs";

export const POST = mutateById("jobId", pauseJob);
