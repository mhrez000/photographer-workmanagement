/** GET /api/bottlenecks -> BottleneckAlert[] */
import { read, methodNotAllowed } from "@/app/api/_lib/route";
import { getBottlenecks } from "@/server/queries/bottlenecks";

export const GET = read((db, ctx) => getBottlenecks(db, ctx));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
