/** POST /api/workflows/:id/reorder { statusIds[] } */
import { mutateById } from "@/app/api/_lib/route";
import { reorderStatuses } from "@/server/services/workflows";

export const POST = mutateById("workflowId", reorderStatuses);
