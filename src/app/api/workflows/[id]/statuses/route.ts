/** POST /api/workflows/:id/statuses { name, key?, category, colour?, description?, sortOrder?, isInitial? } */
import { mutateById } from "@/app/api/_lib/route";
import { addStatus } from "@/server/services/workflows";

export const POST = mutateById("workflowId", addStatus);
