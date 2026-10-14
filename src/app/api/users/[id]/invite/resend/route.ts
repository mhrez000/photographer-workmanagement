import { methodNotAllowed, type IdParams } from "@/app/api/_lib/route";
import { getDb } from "@/db/index";
import { requireContext } from "@/server/auth/session";
import { handle } from "@/server/http";
import { withTx } from "@/server/services/_shared";
import { deliverInvite, resendInvite } from "@/server/services/invites";

/**
 * POST /api/users/:id/invite/resend (admin) → `{ data: { inviteUrl, emailed, expiresAt } }`: a fresh 7-day
 * link for a pending person; the old links stop working. `emailed` is true when the link was emailed
 * (email configured) — otherwise show "Link copied" with `inviteUrl`. Already joined → 422.
 */
export const POST = handle<IdParams>(async (req, { params }) => {
  const ctx = await requireContext();
  const { id } = await params;
  const issued = await withTx((tx) => resendInvite(tx, ctx, { userId: id }));
  return deliverInvite(getDb(), { token: issued.token, expiresAt: issued.expiresAt, userId: id, inviterUserId: ctx.userId, req });
});

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
