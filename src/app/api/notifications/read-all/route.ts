/** POST /api/notifications/read-all -> { updated } */
import { mutate, methodNotAllowed } from "@/app/api/_lib/route";
import { markAllRead } from "@/server/services/notifications";

export const POST = mutate((tx, ctx) => markAllRead(tx, ctx));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
