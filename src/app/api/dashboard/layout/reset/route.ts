/** POST /api/dashboard/layout/reset -> DashboardLayoutView (role default) */
import { mutate } from "@/app/api/_lib/route";
import { resetDashboardLayout } from "@/server/services/dashboards";

export const POST = mutate((tx, ctx) => resetDashboardLayout(tx, ctx));
