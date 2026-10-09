/** POST /api/jobs/:id/resume { expectedVersion, toStatusId?, reason? } - resume a paused job */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { resumeJob } from "@/server/services/jobs";

export const POST = mutateById("jobId", resumeJob);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
