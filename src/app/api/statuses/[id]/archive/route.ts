/** POST /api/statuses/:id/archive { expectedVersion } */
import { mutateById } from "@/app/api/_lib/route";
import { archiveStatus } from "@/server/services/workflows";

export const POST = mutateById("statusId", archiveStatus);
