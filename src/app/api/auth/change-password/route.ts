import { requireContext } from "@/server/auth/session";
import { bodyOrNull, handle } from "@/server/http";
import { changePassword } from "@/server/services/auth";
import { methodNotAllowed } from "@/app/api/_lib/route";

/**
 * POST /api/auth/change-password `{ current, next }` — bumps session_version
 * (signs out every other browser) and re-issues this browser's cookie.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext();
  return changePassword(ctx, await bodyOrNull(req));
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
