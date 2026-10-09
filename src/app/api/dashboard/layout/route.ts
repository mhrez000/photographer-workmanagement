/** GET /api/dashboard/layout -> DashboardLayoutView; PUT { layout, expectedVersion? } */
import { mutate, read, methodNotAllowed } from "@/app/api/_lib/route";
import { getDashboardLayout, putDashboardLayout } from "@/server/services/dashboards";

export const GET = read((db, ctx) => getDashboardLayout(db, ctx));
export const PUT = mutate(putDashboardLayout);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET", "PUT"]);
export const PATCH = methodNotAllowed(["GET", "PUT"]);
export const DELETE = methodNotAllowed(["GET", "PUT"]);
