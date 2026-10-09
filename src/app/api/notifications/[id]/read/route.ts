/** POST /api/notifications/:id/read -> { id, readAt } */
import { mutateById, methodNotAllowed } from "@/app/api/_lib/route";
import { markRead } from "@/server/services/notifications";

export const POST = mutateById("notificationId", markRead);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
