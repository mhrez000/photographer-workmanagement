/** GET /api/settings/permissions -> PermissionMatrixRow[] */
import { read } from "@/app/api/_lib/route";
import { getPermissionMatrix } from "@/server/queries/settings";

export const GET = read((_db, ctx) => getPermissionMatrix(ctx));
