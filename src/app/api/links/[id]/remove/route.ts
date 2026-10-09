/** POST /api/links/:id/remove { reason? } */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { removeLink } from "@/server/services/links";

export const POST = mutateById("linkId", removeLink);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
