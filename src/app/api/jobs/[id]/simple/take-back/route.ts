/** POST /api/jobs/:id/simple/take-back — Take back from editor: { expectedVersion, reason? } → Needs editor (docs/SIMPLIFICATION-PLAN.md §5). */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { takeBackFromEditor } from "@/server/services/simple";

export const POST = mutateById("jobId", takeBackFromEditor);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
