/** GET /api/workflows -> WorkflowListItem[]; POST { name, description?, from?, sourceWorkflowId?, isDefault? } -> WorkflowGraph */
import { mutate, read } from "@/app/api/_lib/route";
import { listWorkflows } from "@/server/queries/workflows";
import { createWorkflow } from "@/server/services/workflows";

export const GET = read((db, ctx) => listWorkflows(db, ctx));
export const POST = mutate(createWorkflow);
