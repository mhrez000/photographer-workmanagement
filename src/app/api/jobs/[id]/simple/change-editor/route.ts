/** POST /api/jobs/:id/simple/change-editor — Change editor: { editorId, expectedVersion, reason? } (docs/SIMPLIFICATION-PLAN.md §5). */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { changeEditor } from "@/server/services/simple";

export const POST = mutateById("jobId", changeEditor);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
