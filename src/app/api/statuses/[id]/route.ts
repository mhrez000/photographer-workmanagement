/** PATCH /api/statuses/:id { expectedVersion, name?, category?, colour?, description?, isInitial? } */
import { mutateById } from "@/app/api/_lib/route";
import { updateStatus } from "@/server/services/workflows";

export const PATCH = mutateById("statusId", updateStatus);
