import { methodNotAllowed } from "@/app/api/_lib/route";
import { getDb } from "@/db/index";
import { requireAnyContext } from "@/server/auth/session";
import { handle } from "@/server/http";
import { disconnectGoogle } from "@/server/services/googleAuth";

/**
 * POST /api/auth/google/disconnect (self, any signed-in role) → `{ data: { ok: true, disconnected } }`. Only with a
 * password (else 422 "Set a password before you disconnect Google"); demo studio → 403. Works whether or not Google
 * sign-in is still configured, so a connected account can always be tidied up.
 */
export const POST = handle(async () => {
  const ctx = await requireAnyContext();
  return disconnectGoogle(getDb(), ctx);
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
