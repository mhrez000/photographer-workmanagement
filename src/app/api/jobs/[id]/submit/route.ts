/** POST /api/jobs/:id/submit { expectedVersion, toStatusId?, reason? } - in_progress -> submitted (resubmitting a revision = POST /api/revisions/:id/resolve) */
import { mutateById } from "@/app/api/_lib/route";
import { submitJob } from "@/server/services/workflow";

export const POST = mutateById("jobId", submitJob);
