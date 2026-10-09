/** POST /api/teams/:id/members/:userId/remove */
import { type RouteParams } from "@/app/api/_lib/route";
import { requireContext } from "@/server/auth/session";
import { handle } from "@/server/http";
import { withTxThenAutomations } from "@/server/services/_shared";
import { removeMember } from "@/server/services/teams";

export const POST = handle<RouteParams<{ id: string; userId: string }>>(async (_req, { params }) => {
  const ctx = await requireContext();
  const { id, userId } = await params;
  return withTxThenAutomations(ctx, (tx) => removeMember(tx, ctx, { teamId: id, userId }));
});
