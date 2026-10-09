/** POST /api/clients/:id/restore { expectedVersion } */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { restoreClient } from "@/server/services/clients";

export const POST = mutateById("clientId", restoreClient);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
