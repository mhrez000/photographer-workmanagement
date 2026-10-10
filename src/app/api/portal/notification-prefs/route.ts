/**
 * GET /api/portal/notification-prefs -> NotificationPrefView[] (the three client types)
 * PUT /api/portal/notification-prefs { prefs: { client_work_shared?, client_work_delivered?, client_feedback_reply? } }
 */
import { getDb } from "@/db/index";
import { methodNotAllowed } from "@/app/api/_lib/route";
import { requirePortalContext } from "@/server/auth/session";
import { bodyOrNull, handle } from "@/server/http";
import { withTx } from "@/server/services/_shared";
import { getPortalNotificationPrefs, setPortalNotificationPrefs } from "@/server/services/portal";

export const GET = handle(async () => {
  const ctx = await requirePortalContext();
  return getPortalNotificationPrefs(getDb(), ctx);
});

export const PUT = handle(async (req) => {
  const ctx = await requirePortalContext();
  const input = await bodyOrNull(req);
  return withTx((tx) => setPortalNotificationPrefs(tx, ctx, input ?? {}));
});

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET", "PUT"]);
export const PATCH = methodNotAllowed(["GET", "PUT"]);
export const DELETE = methodNotAllowed(["GET", "PUT"]);
