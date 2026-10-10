/**
 * GET /api/portal/notifications?unread=1 -> `{ items: PortalNotification[], nextCursor: null }`
 * (client notification types only; the same list envelope as the staff `/api/notifications`).
 */
import { getDb } from "@/db/index";
import { flag, methodNotAllowed, queryOf } from "@/app/api/_lib/route";
import { requirePortalContext } from "@/server/auth/session";
import { handle } from "@/server/http";
import { listPortalNotifications } from "@/server/queries/portal";

export const GET = handle(async (req) => {
  const ctx = await requirePortalContext();
  const items = await listPortalNotifications(getDb(), ctx, { unreadOnly: flag(queryOf(req), "unread") });
  return { items, nextCursor: null };
});

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
