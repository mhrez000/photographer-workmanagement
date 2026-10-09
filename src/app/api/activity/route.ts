/** GET /api/activity?userId&jobId&eventType[]&entityType[]&from&to&cursor&limit -> Paginated<ActivityFeedItem> */
import { read } from "@/app/api/_lib/route";
import { listActivity } from "@/server/queries/activity";

export const GET = read((db, ctx, q) => listActivity(db, ctx, q));
