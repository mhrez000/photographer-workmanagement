/** POST /api/teams/:id/members { userId } */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { addMember } from "@/server/services/teams";

export const POST = mutateById("teamId", addMember);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
