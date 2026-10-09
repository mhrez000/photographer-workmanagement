/** GET /api/dashboard -> DashboardData */
import { read } from "@/app/api/_lib/route";
import { getDashboard } from "@/server/queries/dashboard";

export const GET = read((db, ctx) => getDashboard(db, ctx));
