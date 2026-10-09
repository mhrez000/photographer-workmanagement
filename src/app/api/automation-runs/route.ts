/** GET /api/automation-runs?automationId&status&jobId&cursor&limit -> Paginated<AutomationRunView> */
import { read } from "@/app/api/_lib/route";
import { listAutomationRuns } from "@/server/queries/automations";

export const GET = read((db, ctx, q) => listAutomationRuns(db, ctx, q));
