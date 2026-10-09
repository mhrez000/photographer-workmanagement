/** POST /api/jobs/:id/begin-review { expectedVersion, toStatusId?, reason? } - submitted / resubmitted -> review */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { beginReview } from "@/server/services/workflow";

export const POST = mutateById("jobId", beginReview);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
