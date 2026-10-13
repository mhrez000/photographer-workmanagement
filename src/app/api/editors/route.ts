/** GET /api/editors?period=this_month|last_month|last_3_months -> EditorsOverview — the Editors page: "Waiting on you", one row per editor with the five numbers, extra photographers (SIMPLIFICATION-PLAN §7; owner / co-owner). */
import { methodNotAllowed, one, read } from "@/app/api/_lib/route";
import { getEditorsOverview } from "@/server/queries/editors";

export const GET = read((db, ctx, q) => getEditorsOverview(db, ctx, { period: one(q, "period") }));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
