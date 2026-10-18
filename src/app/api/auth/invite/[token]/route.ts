import { methodNotAllowed, type RouteParams } from "@/app/api/_lib/route";
import { getDb } from "@/db/index";
import { handle } from "@/server/http";
import { lookupInvite } from "@/server/services/invites";

/**
 * GET /api/auth/invite/:token (public) → `{ data: { valid: true, studioName, inviterName, role, persona,
 * personaLabel, email, name, expiresAt } }` for a live invite, else `{ data: { valid: false } }` (200: the page
 * explains that the link no longer works; nothing distinguishes unknown / expired / used).
 */
export const GET = handle<RouteParams<{ token: string }>>(async (_req, { params }) => {
  const { token } = await params;
  return lookupInvite(getDb(), { token });
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
