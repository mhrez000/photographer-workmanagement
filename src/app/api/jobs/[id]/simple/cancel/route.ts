/** POST /api/jobs/:id/simple/cancel — Cancel job: { expectedVersion, reason } (docs/SIMPLIFICATION-PLAN.md §5). */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { cancelJobSimple } from "@/server/services/simple";

export const POST = mutateById("jobId", cancelJobSimple);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
