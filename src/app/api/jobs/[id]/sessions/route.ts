/** GET /api/jobs/:id/sessions -> { sessions: WorkSessionView[], totals: SessionTotals } */
import { readBy, methodNotAllowed } from "@/app/api/_lib/route";
import { listSessions, sessionTotals } from "@/server/services/timeTracking";

export const GET = readBy((db, ctx, id) => ({ sessions: listSessions(db, ctx, id), totals: sessionTotals(db, ctx, id) }));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
