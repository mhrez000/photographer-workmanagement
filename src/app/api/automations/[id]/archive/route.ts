/** POST /api/automations/:id/archive { expectedVersion } */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { archiveAutomation } from "@/server/services/automations";

export const POST = mutateById("automationId", archiveAutomation);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
