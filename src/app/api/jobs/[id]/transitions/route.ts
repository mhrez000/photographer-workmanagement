/** GET /api/jobs/:id/transitions -> { transitions, allowedColumns, actions: JobAvailableActions } */
import { readBy, methodNotAllowed } from "@/app/api/_lib/route";
import { getAllowedTransitions, getAvailableActions } from "@/server/services/workflow";

export const GET = readBy((db, ctx, id) => ({ ...getAllowedTransitions(db, ctx, id), actions: getAvailableActions(db, ctx, id) }));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
