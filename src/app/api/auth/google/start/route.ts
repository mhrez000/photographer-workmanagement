import { cookies } from "next/headers";
import { methodNotAllowed, queryOf } from "@/app/api/_lib/route";
import { getOptionalContext } from "@/server/auth/session";
import { handle } from "@/server/http";
import { googleResultLocation, googleStartRedirect, type GoogleCookie } from "@/server/services/googleAuth";

/**
 * GET /api/auth/google/start?intent=signin|signup|invite|connect&invite=<token>&next=<path> (public; "connect" needs
 * a session). Sets the signed 10-minute round-trip cookie (state + nonce + PKCE verifier, httpOnly, Lax, scoped to
 * /api/auth/google) and answers 302 to Google's account chooser. Never JSON, never a 500 page: Google not configured
 * → 302 back to the page with `?google=disabled`; a bad query (or anything unexpected) → /login?google=failed
 * (docs/ACCOUNTS.md §8 B).
 */
export const GET = handle(async (req) => {
  let location = googleResultLocation(null, "failed");
  let cookie: GoogleCookie | null = null;
  try {
    const ctx = await getOptionalContext();
    ({ location, cookie } = await googleStartRedirect(req, queryOf(req), { ctx }));
  } catch (err) {
    console.error("[google] start route failed", err instanceof Error ? err.name : "unknown");
  }
  if (cookie) {
    const jar = await cookies();
    jar.set(cookie.name, cookie.value, cookie.options);
  }
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
});

/** Every other method → JSON 405 (not Next's empty-body 405). */
export const POST = methodNotAllowed(["GET"]);
export const PUT = methodNotAllowed(["GET"]);
export const PATCH = methodNotAllowed(["GET"]);
export const DELETE = methodNotAllowed(["GET"]);
