/** POST /api/jobs/:id/resume { expectedVersion, toStatusId?, reason? } - resume a paused job */
import { mutateById } from "@/app/api/_lib/route";
import { resumeJob } from "@/server/services/jobs";

export const POST = mutateById("jobId", resumeJob);
