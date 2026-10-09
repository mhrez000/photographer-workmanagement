/** POST /api/workflows/:id/transitions { fromStatusId, toStatusId, label?, allowedRoles, requiresAssignedEditor?, assigneeOnly?, isReopen? } */
import { mutateById } from "@/app/api/_lib/route";
import { addTransition } from "@/server/services/workflows";

export const POST = mutateById("workflowId", addTransition);
