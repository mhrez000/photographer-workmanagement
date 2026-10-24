import { methodNotAllowed } from "@/app/api/_lib/route";
import { getDb } from "@/db/index";
import { loginRedirectTarget } from "@/server/auth/redirect";
import { getOptionalContext } from "@/server/auth/session";
import { bodyOrNull, clientIp, handle } from "@/server/http";
import { accountPathFor } from "@/server/queries/accountSecurity";
import { confirmEmailChange } from "@/server/services/account";

/**
 * POST /api/auth/email-change/confirm `{ token }` (public, CSRF) — the button on /change-email (never on GET: mail
 * scanners open links). → `{ ok: true, email, signedIn, redirectTo }`: the account's address is now `email`
 * (confirmed); "Your Proofline email was changed" goes to the old address. Never signs anyone in. `redirectTo`:
 * the person's own My account (`#email`) when this browser is signed in as them, their landing page when signed in
 * as someone else, else `/login?email=<new address>`. Dead link → 400 "This email change link is no longer valid"
 * (`details.reason: "invalid_link"`); the address taken meanwhile → 400 (`details.reason: "email_taken"`).
 */
export const POST = handle(async (req, _ctx, meta) => {
  const body = await bodyOrNull(req);
  const fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const result = await confirmEmailChange(
    getDb(),
    { token: fields.token, ip: clientIp(req.headers), userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null },
    { req, requestId: meta.requestId },
  );
  const ctx = await getOptionalContext();
  const redirectTo = !ctx
    ? `/login?email=${encodeURIComponent(result.email)}`
    : ctx.userId === result.userId
      ? `${accountPathFor(ctx.role)}#email`
      : loginRedirectTarget(ctx.role, null);
  return { ok: true, email: result.email, signedIn: ctx !== null, redirectTo };
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
