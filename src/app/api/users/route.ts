/**
 * GET  /api/users?role&active&q -> (UserProfile | UserRef)[]
 * POST /api/users (invite, admin) — `method` in the body picks the path (front door):
 *   "link" (default)  -> { user, method: "link", inviteUrl, emailed, expiresAt }   (no password; the person sets
 *                        their own through the link; `emailed` true when it was emailed, else show the link)
 *   "temp_password"   -> { user, method: "temp_password", tempPassword }            (shown once)
 */
import { getDb } from "@/db/index";
import { read, methodNotAllowed } from "@/app/api/_lib/route";
import { requireContext } from "@/server/auth/session";
import { bodyOrNull, handle } from "@/server/http";
import { listUsers } from "@/server/queries/users";
import { runAutomationsAfterCommit } from "@/server/services/_shared";
import { deliverInvite } from "@/server/services/invites";
import { inviteUserByMethod } from "@/server/services/users";

export const GET = read((db, ctx, q) => listUsers(db, ctx, q));
export const POST = handle(async (req) => {
  const ctx = await requireContext();
  const result = await inviteUserByMethod(ctx, await bodyOrNull(req));
  await runAutomationsAfterCommit(getDb(), ctx.organisationId);
  if (result.method === "temp_password" || !result.invite) {
    return { user: result.user, method: "temp_password", tempPassword: result.tempPassword };
  }
  const delivery = await deliverInvite(getDb(), {
    token: result.invite.token,
    expiresAt: result.invite.expiresAt,
    userId: result.user.id,
    inviterUserId: ctx.userId,
    req,
  });
  return { user: result.user, method: "link", ...delivery };
});

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const PUT = methodNotAllowed(["GET", "POST"]);
export const PATCH = methodNotAllowed(["GET", "POST"]);
export const DELETE = methodNotAllowed(["GET", "POST"]);
