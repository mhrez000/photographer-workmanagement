/** POST /api/jobs/:id/approve { expectedVersion, toStatusId?, reason? } - -> approved */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { approveJob } from "@/server/services/workflow";

export const POST = mutateById("jobId", approveJob);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
