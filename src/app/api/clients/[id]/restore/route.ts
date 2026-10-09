/** POST /api/clients/:id/restore { expectedVersion } */
import { mutateById } from "@/app/api/_lib/route";
import { restoreClient } from "@/server/services/clients";

export const POST = mutateById("clientId", restoreClient);
