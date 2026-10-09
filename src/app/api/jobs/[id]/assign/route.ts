/** POST /api/jobs/:id/assign { role: editor|photographer, userId | null, reason?, expectedVersion? } */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { assignRole } from "@/server/services/assignments";

export const POST = mutateById("jobId", assignRole);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
