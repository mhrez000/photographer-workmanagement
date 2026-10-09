/** GET /api/analytics/editors?range -> { range, editors: PerformanceRow[] } */
import { read } from "@/app/api/_lib/route";
import { getAnalyticsEditors } from "@/server/queries/analytics";

export const GET = read((db, ctx, q) => getAnalyticsEditors(db, ctx, q));
