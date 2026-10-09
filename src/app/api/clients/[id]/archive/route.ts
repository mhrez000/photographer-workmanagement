/** POST /api/clients/:id/archive { expectedVersion } */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { archiveClient } from "@/server/services/clients";

export const POST = mutateById("clientId", archiveClient);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
