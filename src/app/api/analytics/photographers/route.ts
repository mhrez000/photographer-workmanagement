/** GET /api/analytics/photographers?range -> { range, photographers: PhotographerPerformanceRow[] } */
import { read, methodNotAllowed } from "@/app/api/_lib/route";
import { getAnalyticsPhotographers } from "@/server/queries/analytics";

export const GET = read((db, ctx, q) => getAnalyticsPhotographers(db, ctx, q));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
