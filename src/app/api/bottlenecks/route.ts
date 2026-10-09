/** GET /api/bottlenecks -> BottleneckAlert[] */
import { read } from "@/app/api/_lib/route";
import { getBottlenecks } from "@/server/queries/bottlenecks";

export const GET = read((db, ctx) => getBottlenecks(db, ctx));
