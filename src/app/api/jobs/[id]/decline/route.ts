/** POST /api/jobs/:id/decline { expectedVersion, toStatusId?, reason? } - assigned -> ready by the assigned editor (reason optional) */
import { mutateById } from "@/app/api/_lib/route";
import { declineJob } from "@/server/services/workflow";

export const POST = mutateById("jobId", declineJob);
