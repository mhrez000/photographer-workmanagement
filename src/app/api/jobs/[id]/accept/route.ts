/** POST /api/jobs/:id/accept { expectedVersion, toStatusId?, reason? } - assigned -> accepted (assigned editor; O/M on behalf) */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { acceptJob } from "@/server/services/workflow";

export const POST = mutateById("jobId", acceptJob);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
