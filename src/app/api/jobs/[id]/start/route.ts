/** POST /api/jobs/:id/start { expectedVersion, toStatusId?, reason? } - -> in_progress ({ startTimer? }) */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { startJob } from "@/server/services/workflow";

export const POST = mutateById("jobId", startJob);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
