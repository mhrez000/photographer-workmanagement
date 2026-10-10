/** POST /api/clients/:id/portal { portalEnabled?, feedbackEnabled?, expectedVersion } -> SetClientPortalResult (admin: `client.manage_portal`, docs/ROLES.md §7.1) */
import { methodNotAllowed, mutateById } from "@/app/api/_lib/route";
import { setClientPortal } from "@/server/services/sharing";

export const POST = mutateById("clientId", setClientPortal);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
