/** PATCH /api/job-types/:id { expectedVersion, name?, colour?, workflowId?, defaultEstimatedHours?, sortOrder? } */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { updateJobType } from "@/server/services/jobTypes";

export const PATCH = mutateById("jobTypeId", updateJobType);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["PATCH"]);
export const POST = methodNotAllowed(["PATCH"]);
export const PUT = methodNotAllowed(["PATCH"]);
export const DELETE = methodNotAllowed(["PATCH"]);
