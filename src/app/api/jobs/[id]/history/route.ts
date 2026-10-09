/** GET /api/jobs/:id/history -> HistoryEntry[] */
import { readBy } from "@/app/api/_lib/route";
import { getJobHistory } from "@/server/queries/jobHistory";

export const GET = readBy((db, ctx, id) => getJobHistory(db, ctx, id));
