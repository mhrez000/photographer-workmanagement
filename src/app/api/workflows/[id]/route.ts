/** GET /api/workflows/:id -> WorkflowGraph; PATCH { expectedVersion, name?, description?, isDefault? } */
import { mutateById, readBy, methodNotAllowed } from "@/app/api/_lib/route";
import { getWorkflowGraph } from "@/server/queries/workflows";
import { updateWorkflow } from "@/server/services/workflows";

export const GET = readBy((db, ctx, id) => getWorkflowGraph(db, ctx, id));
export const PATCH = mutateById("workflowId", updateWorkflow);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET", "PATCH"]);
export const PUT = methodNotAllowed(["GET", "PATCH"]);
export const DELETE = methodNotAllowed(["GET", "PATCH"]);
