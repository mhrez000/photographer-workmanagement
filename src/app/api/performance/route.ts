/** GET /api/performance?range -> PerformanceReport */
import { read, methodNotAllowed } from "@/app/api/_lib/route";
import { getPerformance } from "@/server/queries/performance";

export const GET = read((db, ctx, q) => getPerformance(db, ctx, q));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
