import { methodNotAllowed } from "@/app/api/_lib/route";
import { getDb } from "@/db/index";
import { requireAnyContext } from "@/server/auth/session";
import { handle } from "@/server/http";
import { cancelEmailChange } from "@/server/services/account";

/**
 * POST /api/auth/email-change/cancel (self) → `{ cancelled }`: the waiting email change is closed (its link stops
 * working). 0 = nothing was waiting. Demo studio → 403.
 */
export const POST = handle(async () => {
  const ctx = await requireAnyContext();
  return cancelEmailChange(getDb(), ctx);
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
