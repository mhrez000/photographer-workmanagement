/** GET /api/analytics/me?range -> MyAnalytics */
import { read } from "@/app/api/_lib/route";
import { getMyAnalytics } from "@/server/queries/analytics";

export const GET = read((db, ctx, q) => getMyAnalytics(db, ctx, q));
