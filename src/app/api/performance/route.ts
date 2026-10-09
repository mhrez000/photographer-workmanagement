/** GET /api/performance?range -> PerformanceReport */
import { read } from "@/app/api/_lib/route";
import { getPerformance } from "@/server/queries/performance";

export const GET = read((db, ctx, q) => getPerformance(db, ctx, q));
