/** GET /api/analytics/photographers?range -> { range, photographers: PhotographerPerformanceRow[] } */
import { read } from "@/app/api/_lib/route";
import { getAnalyticsPhotographers } from "@/server/queries/analytics";

export const GET = read((db, ctx, q) => getAnalyticsPhotographers(db, ctx, q));
