/** GET /api/jobs/:id -> JobDetail; PATCH /api/jobs/:id { expectedVersion, ...fields } -> UpdateJobResult */
import { mutateById, readBy, methodNotAllowed } from "@/app/api/_lib/route";
import { getJobDetail } from "@/server/queries/jobDetail";
import { updateJob } from "@/server/services/jobs";

export const GET = readBy((db, ctx, id) => getJobDetail(db, ctx, id));
export const PATCH = mutateById("jobId", updateJob);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET", "PATCH"]);
export const PUT = methodNotAllowed(["GET", "PATCH"]);
export const DELETE = methodNotAllowed(["GET", "PATCH"]);
