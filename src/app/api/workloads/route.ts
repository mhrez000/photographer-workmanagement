/** GET /api/workloads -> WorkloadRow[] (team rows with workloads.view_team, else own row) */
import { read, methodNotAllowed } from "@/app/api/_lib/route";
import { getWorkloads } from "@/server/queries/workloads";

export const GET = read((db, ctx) => getWorkloads(db, ctx));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
