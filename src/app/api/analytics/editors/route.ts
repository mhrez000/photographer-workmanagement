/** GET /api/analytics/editors?range -> { range, editors: PerformanceRow[] } */
import { read, methodNotAllowed } from "@/app/api/_lib/route";
import { getAnalyticsEditors } from "@/server/queries/analytics";

export const GET = read((db, ctx, q) => getAnalyticsEditors(db, ctx, q));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
