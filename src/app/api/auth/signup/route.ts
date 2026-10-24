import { methodNotAllowed } from "@/app/api/_lib/route";
import { getDb } from "@/db/index";
import { markSignedUp } from "@/server/auth/signed-up";
import { bodyOrNull, clientIp, handle } from "@/server/http";
import { sendEmailConfirmation } from "@/server/services/emailVerification";
import { signUpAndSignIn } from "@/server/services/organisations";

/**
 * POST /api/auth/signup `{ ownerName, email, password, studioName, timezone? }` (public, CSRF + 5 / hour / IP)
 * → `{ data: { organisationId, slug, user: { id, name, email, role }, redirectTo: "/home", emailConfirmation } }` + session
 * cookie. `emailConfirmation` = `EmailConfirmationSendResult { sent, reason, devLink?, expiresAt? }` (`devLink` only
 * outside production when no mail provider is set up).
 * Creates the studio (organisation, settings, owner, default workflow, types of shoot) in one transaction.
 * A taken email → 400 `validation` with `fieldErrors.email` (an address with an unopened invite is told to use the
 * invite link); the hidden `website` honeypot filled → the one generic 400; too many attempts → 429 in plain words
 * ("Too many new studios from this network. Try again in N minutes.", `retry-after`).
 * Accounts: then "Confirm your email" is sent to the new owner (`sendEmailConfirmation`, reason "signup"; in production
 * nothing is issued when email is not configured). A mail problem never fails the sign-up.
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
  // Never throws for reason "signup"; `devLink` only ever appears outside production (no mail provider).
  const emailConfirmation = await sendEmailConfirmation(getDb(), { userId: result.userId, reason: "signup", req, requestId: meta.requestId });
  return {
    organisationId: result.organisationId,
    slug: result.slug,
    user: { id: result.userId, name: result.name, email: result.email, role: result.role },
    redirectTo: "/home",
    emailConfirmation,
  };
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const GET = methodNotAllowed(["POST"]);
export const PUT = methodNotAllowed(["POST"]);
export const PATCH = methodNotAllowed(["POST"]);
export const DELETE = methodNotAllowed(["POST"]);
