import { methodNotAllowed } from "@/app/api/_lib/route";
import { getDb } from "@/db/index";
import { requireAnyContext } from "@/server/auth/session";
import { clientIp, handle } from "@/server/http";
import { signOutOtherDevices } from "@/server/services/account";

/**
 * POST /api/auth/sign-out-others (self) → `{ ok: true }`: "Log out of other devices". Bumps the account's
 * session version (every other browser and phone is logged out at its next request) and re-issues THIS browser's
 * cookie, so the person stays signed in here. Demo studio → 403.
 */
export const POST = handle(async (req) => {
  const ctx = await requireAnyContext();
  return signOutOtherDevices(getDb(), ctx, { ip: clientIp(req.headers), userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null });
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
