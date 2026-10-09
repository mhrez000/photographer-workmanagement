/** GET /api/workloads/:userId -> WorkloadDetail */
import { readBy, methodNotAllowed } from "@/app/api/_lib/route";
import { getWorkloadDetail } from "@/server/queries/workloads";

export const GET = readBy((db, ctx, userId) => getWorkloadDetail(db, ctx, userId), "userId");

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
