/** GET /api/kanban?...filters -> KanbanBoard */
import { read } from "@/app/api/_lib/route";
import { getKanbanBoard } from "@/server/queries/kanban";

export const GET = read((db, ctx, q) => getKanbanBoard(db, ctx, q));
