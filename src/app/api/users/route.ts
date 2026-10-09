/** GET /api/users?role&active&q -> (UserProfile | UserRef)[]; POST (invite) -> { user, tempPassword } */
import { getDb } from "@/db/index";
import { read, methodNotAllowed } from "@/app/api/_lib/route";
import { requireContext } from "@/server/auth/session";
import { bodyOrNull, handle } from "@/server/http";
import { listUsers } from "@/server/queries/users";
import { runAutomationsAfterCommit } from "@/server/services/_shared";
import { inviteUserWithTempPassword } from "@/server/services/users";

export const GET = read((db, ctx, q) => listUsers(db, ctx, q));
export const POST = handle(async (req) => {
  const ctx = await requireContext();
  const result = await inviteUserWithTempPassword(ctx, await bodyOrNull(req));
  runAutomationsAfterCommit(getDb(), ctx.organisationId);
  return result;
});

/** Methods this route does not implement: JSON 405 (see methodNotAllowed). */
export const PUT = methodNotAllowed(["GET", "POST"]);
export const PATCH = methodNotAllowed(["GET", "POST"]);
export const DELETE = methodNotAllowed(["GET", "POST"]);
