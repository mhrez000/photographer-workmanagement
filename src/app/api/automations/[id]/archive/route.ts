/** POST /api/automations/:id/archive { expectedVersion } */
import { mutateById } from "@/app/api/_lib/route";
import { archiveAutomation } from "@/server/services/automations";

export const POST = mutateById("automationId", archiveAutomation);
