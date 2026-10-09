/** GET /api/workflows/:id -> WorkflowGraph; PATCH { expectedVersion, name?, description?, isDefault? } */
import { mutateById, readBy } from "@/app/api/_lib/route";
import { getWorkflowGraph } from "@/server/queries/workflows";
import { updateWorkflow } from "@/server/services/workflows";

export const GET = readBy((db, ctx, id) => getWorkflowGraph(db, ctx, id));
export const PATCH = mutateById("workflowId", updateWorkflow);
