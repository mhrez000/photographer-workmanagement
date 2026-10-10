/** POST /api/links/:id/share { shared } -> ShareLinkResult (`link.share_with_client`, current links only; docs/ROLES.md §7.2) */
import { methodNotAllowed, mutateById } from "@/app/api/_lib/route";
import { shareLink } from "@/server/services/sharing";

export const POST = mutateById("linkId", shareLink);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
