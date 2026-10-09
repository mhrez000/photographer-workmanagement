/** POST /api/users/:id/role { role, expectedVersion } */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { changeRole } from "@/server/services/users";

export const POST = mutateById("userId", changeRole);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
