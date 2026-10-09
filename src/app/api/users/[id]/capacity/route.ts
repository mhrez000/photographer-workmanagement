/** POST /api/users/:id/capacity { capacityHoursPerWeek | null, expectedVersion } */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { setCapacity } from "@/server/services/users";

export const POST = mutateById("userId", setCapacity);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
