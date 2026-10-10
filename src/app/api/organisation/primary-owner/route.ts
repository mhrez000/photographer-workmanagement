/** POST /api/organisation/primary-owner { userId, expectedVersion } (docs/ROLES.md §3.4; primary owner only, to another active admin) */
import { mutate, methodNotAllowed } from "@/app/api/_lib/route";
import { transferPrimaryOwner } from "@/server/services/users";

export const POST = mutate(transferPrimaryOwner);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
