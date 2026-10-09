/** GET /api/analytics/overview?range|from&to -> AnalyticsOverview */
import { read } from "@/app/api/_lib/route";
import { getAnalyticsOverview } from "@/server/queries/analytics";

export const GET = read((db, ctx, q) => getAnalyticsOverview(db, ctx, q));
