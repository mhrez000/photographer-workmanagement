/** GET /api/workflows -> WorkflowListItem[]; POST { name, description?, from?, sourceWorkflowId?, isDefault? } -> WorkflowGraph */
import { mutate, read, methodNotAllowed } from "@/app/api/_lib/route";
import { listWorkflows } from "@/server/queries/workflows";
import { createWorkflow } from "@/server/services/workflows";

export const GET = read((db, ctx) => listWorkflows(db, ctx));
export const POST = mutate(createWorkflow);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const PUT = methodNotAllowed(["GET", "POST"]);
export const PATCH = methodNotAllowed(["GET", "POST"]);
export const DELETE = methodNotAllowed(["GET", "POST"]);
