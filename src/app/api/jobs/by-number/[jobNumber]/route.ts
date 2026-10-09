/** GET /api/jobs/by-number/:jobNumber -> JobRow (404 when not visible) */
import { readBy, methodNotAllowed } from "@/app/api/_lib/route";
import { getJobRowByNumber } from "@/server/queries/jobs";

export const GET = readBy((db, ctx, jobNumber) => getJobRowByNumber(db, ctx, decodeURIComponent(jobNumber)), "jobNumber");

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
