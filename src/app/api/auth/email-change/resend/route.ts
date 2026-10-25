import { methodNotAllowed } from "@/app/api/_lib/route";
import { getDb } from "@/db/index";
import { requireAnyContext } from "@/server/auth/session";
import { handle } from "@/server/http";
import { resendEmailChange } from "@/server/services/account";

/**
 * POST /api/auth/email-change/resend (self) → `{ status: "pending", newEmail, expiresAt, sent, reason, devLink? }`:
 * "Send again" — a fresh link to the address already chosen (the older link stops working). Nothing waiting →
 * 422; the address now used by another account → 400 (and the change is closed); demo → 403; shares the
 * 5-an-hour email-change limit (429).
 */
export const POST = handle(async (req, _ctx, meta) => {
  const ctx = await requireAnyContext();
  return resendEmailChange(getDb(), ctx, { req, requestId: meta.requestId });
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
