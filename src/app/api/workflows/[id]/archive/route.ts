/** POST /api/workflows/:id/archive { expectedVersion } */
import { mutateById } from "@/app/api/_lib/route";
import { archiveWorkflow } from "@/server/services/workflows";

export const POST = mutateById("workflowId", archiveWorkflow);
