/** GET /api/automations/:id -> AutomationDetail; PATCH { expectedVersion, ... } */
import { mutateById, readBy } from "@/app/api/_lib/route";
import { getAutomationDetail } from "@/server/queries/automations";
import { updateAutomation } from "@/server/services/automations";

export const GET = readBy((db, ctx, id) => getAutomationDetail(db, ctx, id));
export const PATCH = mutateById("automationId", updateAutomation);
