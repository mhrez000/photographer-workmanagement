/** POST /api/portal/notifications/:id/read -> { id, readAt } (own notifications only; others 404) */
import { methodNotAllowed, type IdParams } from "@/app/api/_lib/route";
import { requirePortalContext } from "@/server/auth/session";
import { handle } from "@/server/http";
import { withTx } from "@/server/services/_shared";
import { markRead } from "@/server/services/notifications";

export const POST = handle<IdParams>(async (_req, { params }) => {
  const ctx = await requirePortalContext();
  const { id } = await params;
  return withTx((tx) => markRead(tx, ctx, { notificationId: id }));
});

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
