/** POST /api/jobs/:id/deliver { expectedVersion, toStatusId?, reason? } - approved -> delivered */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { deliverJob } from "@/server/services/workflow";

export const POST = mutateById("jobId", deliverJob);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
