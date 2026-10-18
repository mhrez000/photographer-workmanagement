import { methodNotAllowed } from "@/app/api/_lib/route";
import { markSignedUp } from "@/server/auth/signed-up";
import { bodyOrNull, clientIp, handle } from "@/server/http";
import { signUpAndSignIn } from "@/server/services/organisations";

/**
 * POST /api/auth/signup `{ ownerName, email, password, studioName, timezone? }` (public, CSRF + 5 / hour / IP)
 * → `{ data: { organisationId, slug, user: { id, name, email, role }, redirectTo: "/home" } }` + session cookie.
 * Creates the studio (organisation, settings, owner, default workflow, types of shoot) in one transaction.
 * A taken email → 400 `validation` with `fieldErrors.email`; too many attempts → 429.
 */
export const POST = handle(async (req, _ctx, meta) => {
  const body = await bodyOrNull(req);
  const fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const result = await signUpAndSignIn(
    { ...fields, ip: clientIp(req.headers), userAgent: req.headers.get("user-agent") },
    { requestId: meta.requestId },
  );
  // This browser now belongs to a real studio: the sign-in page stops offering the demo accounts here.
  await markSignedUp();
  return {
    organisationId: result.organisationId,
    slug: result.slug,
    user: { id: result.userId, name: result.name, email: result.email, role: result.role },
    redirectTo: "/home",
  };
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
