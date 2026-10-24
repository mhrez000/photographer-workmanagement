import { methodNotAllowed } from "@/app/api/_lib/route";
import { getDb } from "@/db/index";
import { loginRedirectTarget } from "@/server/auth/redirect";
import { getOptionalContext } from "@/server/auth/session";
import { bodyOrNull, clientIp, handle } from "@/server/http";
import { confirmEmail } from "@/server/services/emailVerification";

/**
 * POST /api/auth/verify-email `{ token }` (public, CSRF) → `{ data: { ok: true, email, signedIn, redirectTo } }`.
 * The button on /verify-email ("Confirm my email"): confirms the address the link was sent to. Never on GET (mail
 * scanners open links) and never signs anyone in. `redirectTo` = the signed-in person's home, else
 * `/login?email=<email>`. A link that does not work → 400 `validation` "This confirmation link is no longer valid"
 * with `details.reason` ("invalid" | "expired" | "used" | "already_confirmed") so the page can say what to do next.
 */
export const POST = handle(async (req, _ctx, meta) => {
  const body = await bodyOrNull(req);
  const fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const result = await confirmEmail(
    getDb(),
    { token: fields.token, ip: clientIp(req.headers), userAgent: req.headers.get("user-agent") },
    { requestId: meta.requestId },
  );
  const ctx = await getOptionalContext();
  return {
    ok: true,
    email: result.email,
    signedIn: ctx !== null,
    redirectTo: ctx ? loginRedirectTarget(ctx.role, null) : `/login?email=${encodeURIComponent(result.email)}`,
  };
});

/** Every other method → JSON 405 (not Next's empty-body 405). GET in particular: opening a link confirms nothing. */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
