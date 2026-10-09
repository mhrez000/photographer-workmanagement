/** GET /api/automation-runs?automationId&status&jobId&cursor&limit -> Paginated<AutomationRunView> */
import { read, methodNotAllowed } from "@/app/api/_lib/route";
import { listAutomationRuns } from "@/server/queries/automations";

export const GET = read((db, ctx, q) => listAutomationRuns(db, ctx, q));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
