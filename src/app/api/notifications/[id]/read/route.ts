/** POST /api/notifications/:id/read -> { id, readAt } */
import { mutateById } from "@/app/api/_lib/route";
import { markRead } from "@/server/services/notifications";

export const POST = mutateById("notificationId", markRead);
