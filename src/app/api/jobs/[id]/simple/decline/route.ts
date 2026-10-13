/** POST /api/jobs/:id/simple/decline — Editor's "Can't do this one": { expectedVersion, reason } → Needs editor (docs/SIMPLIFICATION-PLAN.md §5). */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { declineJobSimple } from "@/server/services/simple";

export const POST = mutateById("jobId", declineJobSimple);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
