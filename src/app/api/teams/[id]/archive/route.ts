/** POST /api/teams/:id/archive { expectedVersion } */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { archiveTeam } from "@/server/services/teams";

export const POST = mutateById("teamId", archiveTeam);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
