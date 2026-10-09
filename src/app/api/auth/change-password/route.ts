import { requireContext } from "@/server/auth/session";
import { bodyOrNull, handle } from "@/server/http";
import { changePassword } from "@/server/services/auth";

/**
 * POST /api/auth/change-password `{ current, next }` — bumps session_version
 * (signs out every other browser) and re-issues this browser's cookie.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext();
  return changePassword(ctx, await bodyOrNull(req));
});
