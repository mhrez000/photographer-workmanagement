/** POST /api/me/mark-old-updates-read -> { updated } — marks your unread notifications of the 18 now-off-by-default types as read (SIMPLIFICATION-PLAN §8). Nothing is deleted; idempotent. */
import { methodNotAllowed, mutate } from "@/app/api/_lib/route";
import { markOldUpdatesRead } from "@/server/services/simple";

export const POST = mutate((tx, ctx) => markOldUpdatesRead(tx, ctx));

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
