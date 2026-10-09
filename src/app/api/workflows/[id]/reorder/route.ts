/** POST /api/workflows/:id/reorder { statusIds[] } */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { reorderStatuses } from "@/server/services/workflows";

export const POST = mutateById("workflowId", reorderStatuses);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
