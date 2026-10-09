/** POST /api/jobs/:id/decline { expectedVersion, toStatusId?, reason? } - assigned -> ready by the assigned editor (reason optional) */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { declineJob } from "@/server/services/workflow";

export const POST = mutateById("jobId", declineJob);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
