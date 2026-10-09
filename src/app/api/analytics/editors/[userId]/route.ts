/** GET /api/analytics/editors/:userId?range -> EditorAnalytics */
import { readBy } from "@/app/api/_lib/route";
import { getEditorAnalytics } from "@/server/queries/analytics";

export const GET = readBy((db, ctx, userId, q) => getEditorAnalytics(db, ctx, userId, q), "userId");
