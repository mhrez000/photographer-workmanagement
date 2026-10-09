/** POST /api/workflows/:id/statuses { name, key?, category, colour?, description?, sortOrder?, isInitial? } */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { addStatus } from "@/server/services/workflows";

export const POST = mutateById("workflowId", addStatus);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
