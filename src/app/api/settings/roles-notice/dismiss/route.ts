/** POST /api/settings/roles-notice/dismiss { expectedVersion? } (docs/ROLES.md §1.5; admin) */
import { mutate, methodNotAllowed } from "@/app/api/_lib/route";
import { dismissRolesNotice } from "@/server/services/settings";

export const POST = mutate(dismissRolesNotice);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
