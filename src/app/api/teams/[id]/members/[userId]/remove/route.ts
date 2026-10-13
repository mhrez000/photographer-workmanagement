/** POST /api/teams/:id/members/:userId/remove */
import { type RouteParams, methodNotAllowed, requireRouteContext } from "@/app/api/_lib/route";
import { handle } from "@/server/http";
import { withTxThenAutomations } from "@/server/services/_shared";
import { removeMember } from "@/server/services/teams";

export const POST = handle<RouteParams<{ id: string; userId: string }>>(async (req, { params }) => {
  const ctx = await requireRouteContext(req); // Advanced tools (teams): 404 while off
  const { id, userId } = await params;
  return withTxThenAutomations(ctx, (tx) => removeMember(tx, ctx, { teamId: id, userId }));
});

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
