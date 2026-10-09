/** POST /api/automations/:id/toggle { expectedVersion, isEnabled? } (omitted = flip) */
import { mutateById } from "@/app/api/_lib/route";
import { toggleAutomation } from "@/server/services/automations";

export const POST = mutateById("automationId", toggleAutomation);
