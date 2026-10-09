/** GET /api/clients?q&includeArchived -> ClientListItem[]; POST (CreateClientInput) */
import { mutate, read, methodNotAllowed } from "@/app/api/_lib/route";
import { listClients } from "@/server/queries/clients";
import { createClient } from "@/server/services/clients";

export const GET = read((db, ctx, q) => listClients(db, ctx, q));
export const POST = mutate(createClient);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const PUT = methodNotAllowed(["GET", "POST"]);
export const PATCH = methodNotAllowed(["GET", "POST"]);
export const DELETE = methodNotAllowed(["GET", "POST"]);
