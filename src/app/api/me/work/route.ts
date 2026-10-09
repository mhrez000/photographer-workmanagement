/** GET /api/me/work -> MyWorkQueue */
import { read, methodNotAllowed } from "@/app/api/_lib/route";
import { getMyWorkQueue } from "@/server/queries/myWork";

export const GET = read((db, ctx) => getMyWorkQueue(db, ctx));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
