/** POST /api/notifications/read-all -> { updated } */
import { mutate } from "@/app/api/_lib/route";
import { markAllRead } from "@/server/services/notifications";

export const POST = mutate((tx, ctx) => markAllRead(tx, ctx));
