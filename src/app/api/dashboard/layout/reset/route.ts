/** POST /api/dashboard/layout/reset -> DashboardLayoutView (role default) */
import { mutate, methodNotAllowed } from "@/app/api/_lib/route";
import { resetDashboardLayout } from "@/server/services/dashboards";

export const POST = mutate((tx, ctx) => resetDashboardLayout(tx, ctx));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
