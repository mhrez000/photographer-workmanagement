/** GET /api/settings/permissions -> PermissionMatrixRow[] */
import { read, methodNotAllowed } from "@/app/api/_lib/route";
import { getPermissionMatrix } from "@/server/queries/settings";

export const GET = read((_db, ctx) => getPermissionMatrix(ctx));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
