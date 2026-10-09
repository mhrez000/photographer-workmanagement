/** GET /api/automations/:id/runs?status&jobId&cursor&limit -> Paginated<AutomationRunView> */
import { readBy, methodNotAllowed } from "@/app/api/_lib/route";
import { listAutomationRuns } from "@/server/queries/automations";

export const GET = readBy((db, ctx, id, q) => listAutomationRuns(db, ctx, { ...q, automationId: id }));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
