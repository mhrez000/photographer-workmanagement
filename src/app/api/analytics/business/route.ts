/** GET /api/analytics/business?range -> Report (kind business) */
import { read } from "@/app/api/_lib/route";
import { getReport } from "@/server/queries/reports";

export const GET = read((db, ctx, q) => getReport(db, ctx, "business", q));
