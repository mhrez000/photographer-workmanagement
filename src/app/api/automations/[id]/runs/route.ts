/** GET /api/automations/:id/runs?status&jobId&cursor&limit -> Paginated<AutomationRunView> */
import { readBy } from "@/app/api/_lib/route";
import { listAutomationRuns } from "@/server/queries/automations";

export const GET = readBy((db, ctx, id, q) => listAutomationRuns(db, ctx, { ...q, automationId: id }));
