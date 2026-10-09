/** GET /api/jobs/:id/sessions -> { sessions: WorkSessionView[], totals: SessionTotals } */
import { readBy } from "@/app/api/_lib/route";
import { listSessions, sessionTotals } from "@/server/services/timeTracking";

export const GET = readBy((db, ctx, id) => ({ sessions: listSessions(db, ctx, id), totals: sessionTotals(db, ctx, id) }));
