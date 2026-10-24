import { methodNotAllowed } from "@/app/api/_lib/route";
import { getDb } from "@/db/index";
import { requireAnyContext } from "@/server/auth/session";
import { bodyOrNull, clientIp, handle } from "@/server/http";
import { setPassword } from "@/server/services/account";

/**
 * POST /api/auth/set-password `{ password }` (self) → `{ ok: true }`: a first password for an account that has
 * none (Google sign-ups); "A password was added" goes to the account's address. Already has one → 422 (use
 * change-password); demo → 403. This browser stays signed in (nothing was compromised, so no session ends).
 */
export const POST = handle(async (req, _ctx, meta) => {
  const ctx = await requireAnyContext();
  const body = await bodyOrNull(req);
  const fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  return setPassword(
    getDb(),
    ctx,
    { password: fields.password, ip: clientIp(req.headers), userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null },
    { req, requestId: meta.requestId },
  );
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
