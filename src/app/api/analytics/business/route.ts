/** GET /api/analytics/business?range -> Report (kind business) */
import { read, methodNotAllowed } from "@/app/api/_lib/route";
import { getReport } from "@/server/queries/reports";

export const GET = read((db, ctx, q) => getReport(db, ctx, "business", q));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
