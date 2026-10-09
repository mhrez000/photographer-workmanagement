/** GET /api/automations/:id -> AutomationDetail; PATCH { expectedVersion, ... } */
import { mutateById, readBy, methodNotAllowed } from "@/app/api/_lib/route";
import { getAutomationDetail } from "@/server/queries/automations";
import { updateAutomation } from "@/server/services/automations";

export const GET = readBy((db, ctx, id) => getAutomationDetail(db, ctx, id));
export const PATCH = mutateById("automationId", updateAutomation);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET", "PATCH"]);
export const PUT = methodNotAllowed(["GET", "PATCH"]);
export const DELETE = methodNotAllowed(["GET", "PATCH"]);
