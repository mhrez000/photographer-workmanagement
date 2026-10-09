/** GET /api/jobs/:id/timeline -> TimelineRow */
import { readBy } from "@/app/api/_lib/route";
import { getJobTimeline } from "@/server/queries/jobHistory";

export const GET = readBy((db, ctx, id) => getJobTimeline(db, ctx, id));
