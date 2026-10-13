/** GET /api/jobs/:id/simple -> SimpleJobPage — the whole single-scroll job page model (SIMPLIFICATION-PLAN §5). */
import { methodNotAllowed, readBy } from "@/app/api/_lib/route";
import { getJobPageSimple } from "@/server/queries/jobPageSimple";

export const GET = readBy((db, ctx, id) => getJobPageSimple(db, ctx, id));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
