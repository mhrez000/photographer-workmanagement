/** POST /api/links/:id/replace { url, label? } -> { link, previous } */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { replaceLink } from "@/server/services/links";

export const POST = mutateById("linkId", replaceLink);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
