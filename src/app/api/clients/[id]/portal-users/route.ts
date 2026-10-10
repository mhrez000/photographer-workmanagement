/** GET /api/clients/:id/portal-users -> ClientPortalUser[] (docs/ROLES.md §7.1; admin). Invite with POST /api/users { role: "client", clientId }. */
import { readBy, methodNotAllowed } from "@/app/api/_lib/route";
import { listClientPortalUsers } from "@/server/services/users";

export const GET = readBy((db, ctx, id) => listClientPortalUsers(db, ctx, { clientId: id }));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
