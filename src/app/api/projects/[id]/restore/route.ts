/** POST /api/projects/:id/restore { expectedVersion } */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { restoreProject } from "@/server/services/projects";

export const POST = mutateById("projectId", restoreProject);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
