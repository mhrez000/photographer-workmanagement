import { methodNotAllowed } from "@/app/api/_lib/route";
import { getDb } from "@/db/index";
import { requireAnyContext } from "@/server/auth/session";
import { handle } from "@/server/http";
import { resendEmailConfirmation } from "@/server/services/emailVerification";

/**
 * POST /api/auth/email-verification/resend (any signed-in person, for their own address) →
 * `{ data: { sent, reason, devLink?, expiresAt? } }` — "Send again" on the banner, My account and the link page.
 * A fresh 24-hour "Confirm your email" link (older links stop working). `reason`: null (emailed), "not_configured",
 * "demo" (nothing issued in the demo studio) or "failed". `devLink` only outside production. Already confirmed → 422;
 * more than 5 an hour → 429 + `retry-after`.
 */
export const POST = handle(async (req, _ctx, meta) => {
  const ctx = await requireAnyContext();
  return resendEmailConfirmation(getDb(), ctx, { req, requestId: meta.requestId });
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
