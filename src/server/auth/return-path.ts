/**
 * Where a "Log out" button on a public page may land afterwards (no open redirects). Used by the sign-out server
 * action (src/server/actions/auth.ts) behind the "You're signed in as …" notice on /login, /signup and /invite/[token]
 * and the demo studio banner's "Create your own studio":
 *
 *   /login (keeps `?demo=1`), /signup, /invite/<token>     anything else → /login
 */
const INVITE_PATH = /^\/invite\/[A-Za-z0-9_%-]{1,256}$/;
const BASE = "http://proofline.invalid";

export const SIGN_OUT_FALLBACK = "/login";

export function signOutReturnPath(next: unknown): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return SIGN_OUT_FALLBACK;
  let url: URL;
  try {
    url = new URL(next, BASE);
  } catch {
    return SIGN_OUT_FALLBACK;
  }
  if (url.origin !== BASE) return SIGN_OUT_FALLBACK;
  if (url.pathname === "/login") return url.searchParams.get("demo") === "1" ? "/login?demo=1" : "/login";
  if (url.pathname === "/signup") return "/signup";
  if (INVITE_PATH.test(url.pathname)) return url.pathname;
  return SIGN_OUT_FALLBACK;
}
