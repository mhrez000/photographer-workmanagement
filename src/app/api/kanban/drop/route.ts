/** POST /api/kanban/drop { jobId, column, toStatusId?, expectedVersion, reason?, revision?, startTimer? } -> KanbanDropResponse */
import { mutate, methodNotAllowed } from "@/app/api/_lib/route";
import { kanbanDrop } from "@/server/actions/kanban";

export const POST = mutate(kanbanDrop);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
