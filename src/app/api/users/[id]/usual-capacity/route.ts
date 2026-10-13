/** POST /api/users/:id/usual-capacity { usualCapacityJobs | null, expectedVersion } -> SafeUser ("Usually handles up to N"; editors only; admin). */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { setEditorUsualCapacity } from "@/server/services/simple";

export const POST = mutateById("userId", setEditorUsualCapacity);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
