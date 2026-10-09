/** GET /api/projects/:id -> ProjectDetail; PATCH { expectedVersion, ...fields } */
import { mutateById, readBy, methodNotAllowed } from "@/app/api/_lib/route";
import { getProjectDetail } from "@/server/queries/projects";
import { updateProject } from "@/server/services/projects";

export const GET = readBy((db, ctx, id) => getProjectDetail(db, ctx, id));
export const PATCH = mutateById("projectId", updateProject);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET", "PATCH"]);
export const PUT = methodNotAllowed(["GET", "PATCH"]);
export const DELETE = methodNotAllowed(["GET", "PATCH"]);
