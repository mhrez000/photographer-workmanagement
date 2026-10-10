/** POST /api/portal/notifications/read-all -> { updated } */
import { methodNotAllowed } from "@/app/api/_lib/route";
import { requirePortalContext } from "@/server/auth/session";
import { handle } from "@/server/http";
import { withTx } from "@/server/services/_shared";
import { markAllRead } from "@/server/services/notifications";

export const POST = handle(async () => {
  const ctx = await requirePortalContext();
  return withTx((tx) => markAllRead(tx, ctx));
});

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
