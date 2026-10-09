/** GET /api/dashboard/layout -> DashboardLayoutView; PUT { layout, expectedVersion? } */
import { mutate, read } from "@/app/api/_lib/route";
import { getDashboardLayout, putDashboardLayout } from "@/server/services/dashboards";

export const GET = read((db, ctx) => getDashboardLayout(db, ctx));
export const PUT = mutate(putDashboardLayout);
