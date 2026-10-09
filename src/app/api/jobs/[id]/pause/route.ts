/** POST /api/jobs/:id/pause { expectedVersion, toStatusId?, reason? } - pause editing ({ reason? }) */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { pauseJob } from "@/server/services/jobs";

export const POST = mutateById("jobId", pauseJob);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
