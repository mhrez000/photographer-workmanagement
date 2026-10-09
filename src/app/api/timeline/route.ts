/** GET /api/timeline?... -> TimelineRow[] */
import { read } from "@/app/api/_lib/route";
import { getTimelineRows } from "@/server/queries/timeline";

export const GET = read((db, ctx, q) => getTimelineRows(db, ctx, q));
