/** GET /api/jobs/:id/history -> HistoryEntry[] */
import { readBy, methodNotAllowed } from "@/app/api/_lib/route";
import { getJobHistory } from "@/server/queries/jobHistory";

export const GET = readBy((db, ctx, id) => getJobHistory(db, ctx, id));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
