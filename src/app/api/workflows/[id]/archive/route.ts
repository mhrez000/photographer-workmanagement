/** POST /api/workflows/:id/archive { expectedVersion } */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { archiveWorkflow } from "@/server/services/workflows";

export const POST = mutateById("workflowId", archiveWorkflow);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
