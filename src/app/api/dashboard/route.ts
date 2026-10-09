/** GET /api/dashboard -> DashboardData */
import { read, methodNotAllowed } from "@/app/api/_lib/route";
import { getDashboard } from "@/server/queries/dashboard";

export const GET = read((db, ctx) => getDashboard(db, ctx));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
