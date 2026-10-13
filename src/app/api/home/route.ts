/** GET /api/home -> OwnerHome — the fixed Home for owners and photographers (SIMPLIFICATION-PLAN §6). Editors get 403 (they use /api/my-jobs). */
import { methodNotAllowed, read } from "@/app/api/_lib/route";
import { getOwnerHome } from "@/server/queries/home";

export const GET = read((db, ctx) => getOwnerHome(db, ctx));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
