/** GET /api/workloads -> WorkloadRow[] (team rows with workloads.view_team, else own row) */
import { read } from "@/app/api/_lib/route";
import { getWorkloads } from "@/server/queries/workloads";

export const GET = read((db, ctx) => getWorkloads(db, ctx));
