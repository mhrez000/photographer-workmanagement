import { getOptionalContext } from "@/server/auth/session";
import { clientIp, handle, wantsHtml } from "@/server/http";
import { logout } from "@/server/services/auth";

/**
 * POST /api/auth/logout — audits `auth.logged_out` (when signed in) and
 * expires the cookie. HTML form posts (the shell's user menu) get a 303 to
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
