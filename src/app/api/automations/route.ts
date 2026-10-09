/** GET /api/automations?includeArchived=1 -> AutomationListItem[]; POST (CreateAutomationInput) */
import { flag, mutate, read, methodNotAllowed } from "@/app/api/_lib/route";
import { listAutomations } from "@/server/queries/automations";
import { createAutomation } from "@/server/services/automations";

export const GET = read((db, ctx, q) => listAutomations(db, ctx, { includeArchived: flag(q, "includeArchived") }));
export const POST = mutate(createAutomation);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const PUT = methodNotAllowed(["GET", "POST"]);
export const PATCH = methodNotAllowed(["GET", "POST"]);
export const DELETE = methodNotAllowed(["GET", "POST"]);
