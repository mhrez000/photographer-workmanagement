/** POST /api/clients/:id/archive { expectedVersion } */
import { mutateById } from "@/app/api/_lib/route";
import { archiveClient } from "@/server/services/clients";

export const POST = mutateById("clientId", archiveClient);
