/** GET /api/users/:id/notification-prefs -> NotificationPrefView[]; PUT { prefs: { [type]: boolean } } (self only) */
import { mutateById, readBy, methodNotAllowed } from "@/app/api/_lib/route";
import { getNotificationPrefs, setNotificationPrefs } from "@/server/services/users";

export const GET = readBy((db, ctx, id) => getNotificationPrefs(db, ctx, id));
export const PUT = mutateById("userId", setNotificationPrefs);

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET", "PUT"]);
export const PATCH = methodNotAllowed(["GET", "PUT"]);
export const DELETE = methodNotAllowed(["GET", "PUT"]);
