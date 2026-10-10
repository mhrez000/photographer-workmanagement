/**
 * GET   /api/portal/me -> PortalViewer (client-safe: name, email, client, studio, unread count)
 * PATCH /api/portal/me { name, expectedVersion? } -> { name, email, version }
 */
import { getDb } from "@/db/index";
import { methodNotAllowed } from "@/app/api/_lib/route";
import type { PortalViewer } from "@/lib/types";
import { getViewer, requirePortalContext } from "@/server/auth/session";
import { bodyOrNull, handle } from "@/server/http";
import { portalUnreadCount } from "@/server/queries/portal";
import { withTx } from "@/server/services/_shared";
import { updatePortalProfile } from "@/server/services/portal";

export const GET = handle(async (): Promise<PortalViewer> => {
  const ctx = await requirePortalContext();
  const viewer = await getViewer();
  return {
    kind: "client",
    name: viewer?.name ?? "",
    email: viewer?.email ?? "",
    clientName: viewer?.clientName ?? "",
    studioName: viewer?.organisationName ?? "",
    unreadCount: await portalUnreadCount(getDb(), ctx),
  };
});

export const PATCH = handle(async (req) => {
  const ctx = await requirePortalContext();
  const input = await bodyOrNull(req);
  return withTx((tx) => updatePortalProfile(tx, ctx, input ?? {}));
});

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const POST = methodNotAllowed(["GET", "PATCH"]);
export const PUT = methodNotAllowed(["GET", "PATCH"]);
export const DELETE = methodNotAllowed(["GET", "PATCH"]);
