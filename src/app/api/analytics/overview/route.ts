/** GET /api/analytics/overview?range|from&to -> AnalyticsOverview */
import { read, methodNotAllowed } from "@/app/api/_lib/route";
import { getAnalyticsOverview } from "@/server/queries/analytics";

export const GET = read((db, ctx, q) => getAnalyticsOverview(db, ctx, q));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
