/** PATCH /api/transitions/:id { label?, allowedRoles?, requiresAssignedEditor?, assigneeOnly?, isReopen? } */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { updateTransition } from "@/server/services/workflows";

export const PATCH = mutateById("transitionId", updateTransition);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["PATCH"]);
export const POST = methodNotAllowed(["PATCH"]);
export const PUT = methodNotAllowed(["PATCH"]);
export const DELETE = methodNotAllowed(["PATCH"]);
