/** POST /api/kanban/drop { jobId, column, toStatusId?, expectedVersion, reason?, revision?, startTimer? } -> KanbanDropResponse */
import { mutate } from "@/app/api/_lib/route";
import { kanbanDrop } from "@/server/actions/kanban";

export const POST = mutate(kanbanDrop);
