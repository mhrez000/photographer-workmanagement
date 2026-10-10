/** GET /api/dashboard -> DashboardData */
import { read, methodNotAllowed } from "@/app/api/_lib/route";
import { getDashboard } from "@/server/queries/dashboard";
import { scopeCookie } from "@/app/api/_lib/scope";

export const GET = read(async (db, ctx, q) => getDashboard(db, ctx, { scope: typeof q.scope === "string" ? q.scope : null, ...(await scopeCookie()) }));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
