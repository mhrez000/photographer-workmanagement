/** POST /api/jobs/:id/simple/assign { editorId, expectedVersion } -> AssignEditorSimpleResult — Assign editor (Needs editor -> With editor; the engine skips "Ready") (SIMPLIFICATION-PLAN §5). */
import { methodNotAllowed, mutateById } from "@/app/api/_lib/route";
import { assignEditorSimple } from "@/server/services/simple";

export const POST = mutateById("jobId", assignEditorSimple);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
