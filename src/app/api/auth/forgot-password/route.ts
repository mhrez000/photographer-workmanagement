import { methodNotAllowed } from "@/app/api/_lib/route";
import { getDb } from "@/db/index";
import { bodyOrNull, clientIp, handle } from "@/server/http";
import { requestPasswordReset } from "@/server/services/passwordReset";

/**
 * POST /api/auth/forgot-password `{ email }` (public, CSRF, 5 / 15 min per email + IP → 429)
 * → `{ data: { ok: true, emailed, resetUrl? } }`. ALWAYS ok: whether the address has an account is never
 * revealed (a person of the demo studio gets no link at all). `resetUrl` appears only in local development without
 * an email provider. The 429 says how many minutes to wait ("Too many reset emails asked for. Try again in N minutes.").
 */
export const POST = handle(async (req, _ctx, meta) => {
  const body = await bodyOrNull(req);
  const fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  return requestPasswordReset(
    getDb(),
    { email: fields.email, ip: clientIp(req.headers), userAgent: req.headers.get("user-agent") },
    { req, requestId: meta.requestId },
  );
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
