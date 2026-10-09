/**
 * PATCH /api/links/:id { kind?, label? } -> JobLink (the new current row; same URL)
 * Re-files and/or relabels a current link (a supersession: the id changes).
 * Permission as /replace, plus link.add for a new kind. Stale link -> 409.
 */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { updateLink } from "@/server/services/links";

export const PATCH = mutateById("linkId", updateLink);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["PATCH"]);
export const POST = methodNotAllowed(["PATCH"]);
export const PUT = methodNotAllowed(["PATCH"]);
export const DELETE = methodNotAllowed(["PATCH"]);
