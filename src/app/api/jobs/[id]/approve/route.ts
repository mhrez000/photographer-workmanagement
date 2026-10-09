/** POST /api/jobs/:id/approve { expectedVersion, toStatusId?, reason? } - -> approved */
import { mutateById } from "@/app/api/_lib/route";
import { approveJob } from "@/server/services/workflow";

export const POST = mutateById("jobId", approveJob);
