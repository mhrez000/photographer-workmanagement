/** GET /api/jobs/:id/activity?cursor&limit&eventType -> Paginated<ActivityFeedItem> */
import { readBy } from "@/app/api/_lib/route";
import { getJobActivity } from "@/server/queries/jobHistory";

export const GET = readBy((db, ctx, id, q) => getJobActivity(db, ctx, id, q));
