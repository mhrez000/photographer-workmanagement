/** GET /api/analytics/editors/:userId?range -> EditorAnalytics */
import { readBy, methodNotAllowed } from "@/app/api/_lib/route";
import { getEditorAnalytics } from "@/server/queries/analytics";

export const GET = readBy((db, ctx, userId, q) => getEditorAnalytics(db, ctx, userId, q), "userId");

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
