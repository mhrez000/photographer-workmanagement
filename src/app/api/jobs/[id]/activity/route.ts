/** GET /api/jobs/:id/activity?cursor&limit&eventType -> Paginated<ActivityFeedItem> */
import { readBy, methodNotAllowed } from "@/app/api/_lib/route";
import { getJobActivity } from "@/server/queries/jobHistory";

export const GET = readBy((db, ctx, id, q) => getJobActivity(db, ctx, id, q));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
