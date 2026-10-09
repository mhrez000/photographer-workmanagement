import { getOptionalContext } from "@/server/auth/session";
import { clientIp, handle, wantsHtml } from "@/server/http";
import { logout } from "@/server/services/auth";
import { methodNotAllowed } from "@/app/api/_lib/route";

/**
 * POST /api/auth/logout — when signed in, bumps the user's session_version
 * (revokes every outstanding cookie: all devices are signed out) and audits
 * `auth.logged_out`; then expires the cookie. HTML form posts (the shell's user menu) get a 303 to
 * /login; fetch callers get `{ data: { ok: true } }`.
 */
export const POST = handle(async (req) => {
  const ctx = await getOptionalContext();
  await logout(ctx, { ip: clientIp(req.headers), userAgent: req.headers.get("user-agent") });
  if (wantsHtml(req)) {
    return new Response(null, { status: 303, headers: { location: "/login" } });
  }
  return { ok: true };
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
