/** GET /api/kanban?...filters -> KanbanBoard */
import { read, methodNotAllowed } from "@/app/api/_lib/route";
import { getKanbanBoard } from "@/server/queries/kanban";
import { scopeCookie } from "@/app/api/_lib/scope";

export const GET = read(async (db, ctx, q) => getKanbanBoard(db, ctx, q, await scopeCookie()));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
