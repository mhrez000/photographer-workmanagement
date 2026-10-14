import { methodNotAllowed } from "@/app/api/_lib/route";
import { loginRedirectTarget } from "@/server/auth/redirect";
import { bodyOrNull, clientIp, handle } from "@/server/http";
import { resetPasswordAndSignIn } from "@/server/services/passwordReset";

/**
 * POST /api/auth/reset-password `{ token, password }` (public, CSRF) → `{ data: { ok: true, redirectTo } }` +
 * session cookie (every other session of the account is revoked). An unknown / expired / used link → 400
 * `validation` "This reset link is no longer valid".
 */
export const POST = handle(async (req, _ctx, meta) => {
  const body = await bodyOrNull(req);
  const fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const result = await resetPasswordAndSignIn(
    { token: fields.token, password: fields.password, ip: clientIp(req.headers), userAgent: req.headers.get("user-agent") },
    { requestId: meta.requestId },
  );
  return { ok: true, redirectTo: loginRedirectTarget(result.role, null) };
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
