/** GET /api/clients/:id -> ClientDetail; PATCH { expectedVersion, ...fields } */
import { mutateById, readBy, methodNotAllowed } from "@/app/api/_lib/route";
import { getClientDetail } from "@/server/queries/clients";
import { updateClient } from "@/server/services/clients";

export const GET = readBy((db, ctx, id) => getClientDetail(db, ctx, id));
export const PATCH = mutateById("clientId", updateClient);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET", "PATCH"]);
export const PUT = methodNotAllowed(["GET", "PATCH"]);
export const DELETE = methodNotAllowed(["GET", "PATCH"]);
