import { methodNotAllowed, mutateById } from "@/app/api/_lib/route";
import { revokeInvite } from "@/server/services/invites";

/**
 * POST /api/users/:id/invite/revoke (admin) → `{ data: { userId, revoked } }`: every live invite link of a
 * pending person stops working (`revoked` = how many; 0 is still a success). The account stays, with no way in,
 * until a new link is sent or the person is deactivated. Already joined → 422.
 */
export const POST = mutateById("userId", revokeInvite);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
