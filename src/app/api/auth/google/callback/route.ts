import { methodNotAllowed } from "@/app/api/_lib/route";
import { getDb } from "@/db/index";
import { handle } from "@/server/http";
import { googleResultLocation, handleGoogleCallback } from "@/server/services/googleAuth";

/**
 * GET /api/auth/google/callback?code&state (or ?error) — where Google sends the browser back (public; 30 / 15 min /
 * IP). Always a 302 to a page, never JSON: signed in (`loginRedirectTarget`), the invite accepted, Google connected
 * (`<account page>?google=connected`), the /signup/google finish page for a new person, or back to the page with
 * `?google=<result>` (cancelled, expired, failed, refused, unverified_email, linked_elsewhere, disabled). The
 * round-trip cookie is cleared on every call. `handleGoogleCallback` never throws; the catch here is a last resort
 * (e.g. the database is unreachable) so the person still lands on a page with a plain message.
 */
export const GET = handle(async (req, _ctx, meta) => {
  let location = googleResultLocation(null, "failed");
  try {
    location = (await handleGoogleCallback(getDb(), req, { requestId: meta.requestId })).location;
  } catch (err) {
    console.error("[google] callback route failed", err instanceof Error ? err.name : "unknown");
  }
  // The callback URL carries the one-time code: never let it leak through a Referer or a cache.
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
