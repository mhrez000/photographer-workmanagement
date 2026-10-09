/** POST /api/jobs/:id/recompute - owner-only repair of derived columns -> RecomputeResult */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { repairJob } from "@/server/services/jobs";

export const POST = mutateById("jobId", repairJob);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
