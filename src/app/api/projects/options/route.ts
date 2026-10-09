/** GET /api/projects/options?q&clientId -> ProjectOption[] */
import { read } from "@/app/api/_lib/route";
import { getProjectOptions } from "@/server/queries/options";

export const GET = read((db, ctx, q) => getProjectOptions(db, ctx, q));
