/** GET /api/jobs/:id/timeline -> TimelineRow */
import { readBy, methodNotAllowed } from "@/app/api/_lib/route";
import { getJobTimeline } from "@/server/queries/jobHistory";

export const GET = readBy((db, ctx, id) => getJobTimeline(db, ctx, id));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
