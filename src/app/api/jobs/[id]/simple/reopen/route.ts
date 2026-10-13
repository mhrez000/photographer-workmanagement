/** POST /api/jobs/:id/simple/reopen — Reopen a Done job: { expectedVersion, reason: client_changes|fix_delivery_link, note?, newLink? } (docs/SIMPLIFICATION-PLAN.md §5). */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { reopenJobSimple } from "@/server/services/simple";

export const POST = mutateById("jobId", reopenJobSimple);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
