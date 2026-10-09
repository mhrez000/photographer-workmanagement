/** POST /api/jobs/:id/cancel { expectedVersion, toStatusId?, reason? } - any active -> cancelled (reason required) */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { cancelJob } from "@/server/services/workflow";

export const POST = mutateById("jobId", cancelJob);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
