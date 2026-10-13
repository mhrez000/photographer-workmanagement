/** GET /api/editors/:id?period -> EditorDetail — one editor's page: five numbers vs last month, on their desk now, recently finished, finished per week (SIMPLIFICATION-PLAN §7). 404 for a non-editor id. */
import { methodNotAllowed, one, readBy } from "@/app/api/_lib/route";
import { getEditorDetail } from "@/server/queries/editors";

export const GET = readBy((db, ctx, id, q) => getEditorDetail(db, ctx, id, { period: one(q, "period") }));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
