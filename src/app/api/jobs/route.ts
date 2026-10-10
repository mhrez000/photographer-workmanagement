/** GET /api/jobs (filters, sort, groupBy, viewId, cursor, limit; unknown keys → 400) -> JobListResult; POST /api/jobs (CreateJobInput) -> CreateJobResult */
import { mutate, read, methodNotAllowed } from "@/app/api/_lib/route";
import { listJobsApi } from "@/server/queries/jobs";
import { createJob } from "@/server/services/jobs";
import { scopeCookie } from "@/app/api/_lib/scope";

export const GET = read(async (db, ctx, q) => listJobsApi(db, ctx, q, await scopeCookie()));
export const POST = mutate(createJob);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const PUT = methodNotAllowed(["GET", "POST"]);
export const PATCH = methodNotAllowed(["GET", "POST"]);
export const DELETE = methodNotAllowed(["GET", "POST"]);
