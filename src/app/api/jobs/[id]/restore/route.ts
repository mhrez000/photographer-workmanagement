/** POST /api/jobs/:id/restore { expectedVersion, toStatusId?, reason? } - cancelled -> the status it was cancelled from */
import { mutateById } from "@/app/api/_lib/route";
import { restoreJob } from "@/server/services/workflow";

export const POST = mutateById("jobId", restoreJob);
