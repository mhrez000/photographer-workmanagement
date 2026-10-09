/** GET /api/clients/options?q -> ClientOption[] */
import { read } from "@/app/api/_lib/route";
import { getClientOptions } from "@/server/queries/options";

export const GET = read((db, ctx, q) => getClientOptions(db, ctx, q));
