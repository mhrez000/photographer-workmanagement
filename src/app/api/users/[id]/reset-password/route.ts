/** POST /api/users/:id/reset-password -> { userId, tempPassword } (sessions revoked) */
import { type IdParams, withFields } from "@/app/api/_lib/route";
import { requireContext } from "@/server/auth/session";
import { bodyOrNull, handle } from "@/server/http";
import { resetPasswordWithTempPassword } from "@/server/services/users";

export const POST = handle<IdParams>(async (req, { params }) => {
  const ctx = await requireContext();
  const { id } = await params;
  return resetPasswordWithTempPassword(ctx, withFields(await bodyOrNull(req), { userId: id }));
});
