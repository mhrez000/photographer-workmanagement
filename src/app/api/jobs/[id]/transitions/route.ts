/** GET /api/jobs/:id/transitions -> { transitions, allowedColumns, actions: JobAvailableActions } */
import { readBy } from "@/app/api/_lib/route";
import { getAllowedTransitions, getAvailableActions } from "@/server/services/workflow";

export const GET = readBy((db, ctx, id) => ({ ...getAllowedTransitions(db, ctx, id), actions: getAvailableActions(db, ctx, id) }));
