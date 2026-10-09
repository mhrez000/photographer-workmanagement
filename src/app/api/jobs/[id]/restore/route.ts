/** POST /api/jobs/:id/restore { expectedVersion, toStatusId?, reason? } - cancelled -> the status it was cancelled from */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { restoreJob } from "@/server/services/workflow";

export const POST = mutateById("jobId", restoreJob);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
