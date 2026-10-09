/** POST /api/jobs/:id/deliver { expectedVersion, toStatusId?, reason? } - approved -> delivered */
import { mutateById } from "@/app/api/_lib/route";
import { deliverJob } from "@/server/services/workflow";

export const POST = mutateById("jobId", deliverJob);
