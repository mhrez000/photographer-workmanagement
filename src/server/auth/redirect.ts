/**
 * Post-login landing (docs/SIMPLIFICATION-PLAN.md §3; docs/ROLES.md §7.8): clients
 * only inside /portal; staff never in /portal. Photographers land on Home, editors on
 * My jobs. Only same-site relative paths are honoured for `next` (no open redirects).
 */
import type { Role } from "@/lib/constants";

/** Mirrors `homePathFor` in src/server/page.ts (kept here so this module stays free of server-only imports). */
const STAFF_HOME = "/home";
const EDITOR_HOME = "/my-jobs";
const PORTAL_HOME = "/portal";

/** A host that can never be real: `next` must resolve against it and stay on it. */
const SAME_SITE_BASE = "http://proofline.invalid";
const NEXT_MAX_LENGTH = 2048;
/**
 * Control characters (browsers silently drop TAB / CR / LF from URLs, so "/\t/evil.example" becomes "//evil.example")
 * and backslashes (read as "/" by browsers: "/\\evil.example" is "//evil.example").
 */
const UNSAFE_NEXT_CHARS = /[\u0000-\u001F\u007F\\]/;

function isPortalPath(p: string): boolean {
  return p === "/portal" || p.startsWith("/portal/") || p.startsWith("/portal?");
}

/**
 * The `next` sanitiser every sign-in path uses (password, Google, demo): only a same-site relative path, never
 * `//host`, `/\host`, a path with a control character or backslash anywhere, or the sign-in page itself. The value is
 * parsed the way a browser would (WHATWG URL against a fake origin) and must stay on that origin; the normalised
 * `path?query#hash` is returned. Anything else → null.
 */
export function safeNextPath(next: unknown): string | null {
  if (typeof next !== "string" || next.length === 0 || next.length > NEXT_MAX_LENGTH) return null;
  if (UNSAFE_NEXT_CHARS.test(next) || !next.startsWith("/") || next.startsWith("//")) return null;
  let url: URL;
  try {
    url = new URL(next, SAME_SITE_BASE);
  } catch {
    return null;
  }
  if (url.origin !== SAME_SITE_BASE) return null;
  // Dot segments can normalise INTO a protocol-relative path ("/.//evil", "/a/..//evil", "/%2e//evil" → "//evil"),
  // which a browser would read as another host: check the normalised value, not only the raw one.
  if (url.pathname.startsWith("//")) return null;
  if (url.pathname.startsWith("/login")) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

export function loginRedirectTarget(role: Role, next: unknown): string {
  const safe = safeNextPath(next);
  if (role === "client") return safe && isPortalPath(safe) ? safe : PORTAL_HOME;
  if (safe && !isPortalPath(safe) && safe !== "/dashboard") return safe;
  return role === "editor" ? EDITOR_HOME : STAFF_HOME;
}
