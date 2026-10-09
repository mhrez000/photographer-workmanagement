/** GET /api/users/:id/notification-prefs -> NotificationPrefView[]; PUT { prefs: { [type]: boolean } } (self only) */
import { mutateById, readBy } from "@/app/api/_lib/route";
import { getNotificationPrefs, setNotificationPrefs } from "@/server/services/users";

export const GET = readBy((db, ctx, id) => getNotificationPrefs(db, ctx, id));
export const PUT = mutateById("userId", setNotificationPrefs);
