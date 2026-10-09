/** PATCH /api/transitions/:id { label?, allowedRoles?, requiresAssignedEditor?, assigneeOnly?, isReopen? } */
import { mutateById } from "@/app/api/_lib/route";
import { updateTransition } from "@/server/services/workflows";

export const PATCH = mutateById("transitionId", updateTransition);
