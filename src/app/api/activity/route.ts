/** GET /api/activity?userId&jobId&eventType[]&entityType[]&from&to&cursor&limit -> Paginated<ActivityFeedItem> */
import { read, methodNotAllowed } from "@/app/api/_lib/route";
import { listActivity } from "@/server/queries/activity";

export const GET = read((db, ctx, q) => listActivity(db, ctx, q));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
