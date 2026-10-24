import { methodNotAllowed } from "@/app/api/_lib/route";
import { getDb } from "@/db/index";
import { bodyOrNull, clientIp, handle } from "@/server/http";
import { completeGoogleSignUp } from "@/server/services/googleAuth";

/**
 * POST /api/auth/google/complete `{ studioName, ownerName?, timezone?, website? }` (public, CSRF; the sign-up limit,
 * 5 / hour / IP) + the signed /signup/google finish cookie → `{ data: { organisationId, slug, user, redirectTo } }` +
 * the session cookie. Creates the studio and its Google-only owner (no password, email confirmed) in one
 * transaction. No / expired finish cookie → 400 "Start again with Continue with Google"; a taken email → 400.
 */
export const POST = handle(async (req, _ctx, meta) => {
  const body = await bodyOrNull(req);
  const fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  return completeGoogleSignUp(getDb(), { ...fields, ip: clientIp(req.headers), userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null }, { requestId: meta.requestId });
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
