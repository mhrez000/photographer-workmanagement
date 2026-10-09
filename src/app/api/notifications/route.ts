/** GET /api/notifications?unread=1&cursor&limit -> Paginated<NotificationView> */
import { read, methodNotAllowed } from "@/app/api/_lib/route";
import { listNotifications } from "@/server/queries/notifications";

export const GET = read((db, ctx, q) => listNotifications(db, ctx, q));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
