import { methodNotAllowed, type RouteParams } from "@/app/api/_lib/route";
import { loginRedirectTarget } from "@/server/auth/redirect";
import { bodyOrNull, clientIp, handle } from "@/server/http";
import { acceptInviteAndSignIn } from "@/server/services/invites";

/**
 * POST /api/auth/invite/:token/accept `{ password, name? }` (public, CSRF) → `{ data: { user: { id, name, email,
 * role }, redirectTo } }` + session cookie (photographers → /home, editors → /my-jobs, clients → /portal).
 * Any invalid link → 400 `validation` "This invite link is no longer valid". Accounts: the email counts as confirmed
 * only when the inviter's own email is confirmed and email is set up (SEC-05); otherwise "Confirm your email" is sent
 * (`sendEmailConfirmation` reason "invite", never failing the join).
 */
export const POST = handle<RouteParams<{ token: string }>>(async (req, { params }, meta) => {
  const { token } = await params;
  const body = await bodyOrNull(req);
  const fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const result = await acceptInviteAndSignIn(
    { token, password: fields.password, ...(fields.name !== undefined ? { name: fields.name } : {}), ip: clientIp(req.headers), userAgent: req.headers.get("user-agent") },
    { requestId: meta.requestId, req },
  );
  return {
    user: { id: result.userId, name: result.name, email: result.email, role: result.role },
    redirectTo: loginRedirectTarget(result.role, null),
  };
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
