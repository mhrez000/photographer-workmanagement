/** POST /api/projects/:id/share { shared, expectedVersion } -> ShareProjectResult (admin: `project.share_with_client`, docs/ROLES.md §7.2) */
import { methodNotAllowed, mutateById } from "@/app/api/_lib/route";
import { shareProject } from "@/server/services/sharing";

export const POST = mutateById("projectId", shareProject);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
