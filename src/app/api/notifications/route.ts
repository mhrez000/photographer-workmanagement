/** GET /api/notifications?unread=1&cursor&limit -> Paginated<NotificationView> */
import { read } from "@/app/api/_lib/route";
import { listNotifications } from "@/server/queries/notifications";

export const GET = read((db, ctx, q) => listNotifications(db, ctx, q));
