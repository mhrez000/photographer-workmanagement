/** GET /api/clients?q&includeArchived -> ClientListItem[]; POST (CreateClientInput) */
import { mutate, read } from "@/app/api/_lib/route";
import { listClients } from "@/server/queries/clients";
import { createClient } from "@/server/services/clients";

export const GET = read((db, ctx, q) => listClients(db, ctx, q));
export const POST = mutate(createClient);
