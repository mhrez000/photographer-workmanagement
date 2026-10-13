/** POST /api/jobs/:id/simple/ask-for-changes — Ask for changes: { expectedVersion, note, chips?, neededBy? } → Changes asked (docs/SIMPLIFICATION-PLAN.md §5). */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { askForChanges } from "@/server/services/simple";

export const POST = mutateById("jobId", askForChanges);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
