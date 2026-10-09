/** GET /api/clients/:id -> ClientDetail; PATCH { expectedVersion, ...fields } */
import { mutateById, readBy } from "@/app/api/_lib/route";
import { getClientDetail } from "@/server/queries/clients";
import { updateClient } from "@/server/services/clients";

export const GET = readBy((db, ctx, id) => getClientDetail(db, ctx, id));
export const PATCH = mutateById("clientId", updateClient);
