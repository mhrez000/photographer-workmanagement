import { methodNotAllowed } from "@/app/api/_lib/route";
import { getDb } from "@/db/index";
import { requireAnyContext } from "@/server/auth/session";
import { bodyOrNull, clientIp, handle } from "@/server/http";
import { requestEmailChange } from "@/server/services/account";

/**
 * POST /api/auth/email-change `{ newEmail, password }` (any signed-in person, self only; docs/ACCOUNTS.md "My
 * account"). Email set up → `{ status: "pending", newEmail, expiresAt, sent, reason, devLink? }`: a link goes to the
 * NEW address and a notice to the old one; nothing changes until the link is opened. Not set up →
 * `{ status: "changed", email }` (applies at once; the new address is unconfirmed). Wrong password → 400
 * `fieldErrors.password`; same / taken address → 400 `fieldErrors.newEmail`; no password yet → 422; demo → 403;
 * 5 requests an hour → 429.
 */
export const POST = handle(async (req, _ctx, meta) => {
  const ctx = await requireAnyContext();
  const body = await bodyOrNull(req);
  const fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  return requestEmailChange(
    getDb(),
    ctx,
    { newEmail: fields.newEmail, password: fields.password, ip: clientIp(req.headers), userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null },
    { req, requestId: meta.requestId },
  );
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
