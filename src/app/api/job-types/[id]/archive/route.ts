/** POST /api/job-types/:id/archive { expectedVersion } */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { archiveJobType } from "@/server/services/jobTypes";

export const POST = mutateById("jobTypeId", archiveJobType);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
