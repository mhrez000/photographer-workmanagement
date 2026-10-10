/** POST /api/jobs/:id/claim { expectedVersion } -> AssignEditorResult (editor takes an unassigned job they created; `job.claim`, docs/ROLES.md §4.3) */
import { methodNotAllowed, mutateById } from "@/app/api/_lib/route";
import { claimJob } from "@/server/services/jobs";

export const POST = mutateById("jobId", claimJob);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
