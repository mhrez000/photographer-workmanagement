/** POST /api/jobs/:id/reopen { expectedVersion, toStatusId?, reason? } - completed -> in_progress | revision | approved ({ toCategory?, reason, revision? }) */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { reopenJob } from "@/server/services/workflow";

export const POST = mutateById("jobId", reopenJob);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
