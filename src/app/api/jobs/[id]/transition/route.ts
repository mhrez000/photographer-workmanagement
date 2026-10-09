/** POST /api/jobs/:id/transition { toStatusId | toCategory, expectedVersion, reason?, override?, revision?, startTimer? } -> TransitionResult */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { transitionJobStatus } from "@/server/services/workflow";

export const POST = mutateById("jobId", transitionJobStatus);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
