/** GET /api/reports/:kind?range&format=json|csv -> Report, or a text/csv attachment (dates + file name in the org timezone) */
import { readBy, methodNotAllowed } from "@/app/api/_lib/route";
import { reportResponse } from "@/app/api/_lib/reports";

export const GET = readBy((db, ctx, kind, q) => reportResponse(db, ctx, kind, q), "kind");

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
