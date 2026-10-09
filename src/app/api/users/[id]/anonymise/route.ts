/** POST /api/users/:id/anonymise { expectedVersion } (owner; deactivated target) */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { anonymiseUser } from "@/server/services/users";

export const POST = mutateById("userId", anonymiseUser);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
