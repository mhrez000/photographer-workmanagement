/**
 * Edge gate (Next 16 `proxy`, ARCHITECTURE.md §3.3, docs/ROLES.md §7.8, docs/SIMPLIFICATION-PLAN.md §3,
 * docs/ACCOUNTS.md §1 + §5). Routing uses cookie PRESENCE plus the UNVERIFIED session claims `k` (kind) and `r`
 * (role) — no DB. `requireContext()` / `requirePortalContext()` and the (app) / portal layouts are the real boundary.
 *
 * - no session cookie on an app page → redirect to /login?next=<path>; the front door is public
 *   (/, /login, /signup, /forgot-password, /reset-password, /invite/*, /verify-email, /change-email, /signup/google,
 *   /api/auth/*)
 * - no session cookie on /api/* (except /api/auth/*) → 401 JSON
 * - `/` is public for EVERYONE: a signed-in person sees the landing page too (its header offers "Go to your studio")
 * - /login and /signup are never redirected: for a signed-in person the pages render "You're signed in as <name>.
 *   [Go to your studio] [Log out]" instead of the form. `?expired=1` (set by the layouts when the cookie is
 *   stale / revoked) deletes the cookie, so the sign-in form renders — no redirect loop
 * - client cookie on a staff page → /portal; staff cookie on /portal* → the staff landing page
 * - /workspace/my (the old "My Work") → /my-jobs for editors, /jobs for everyone else
 * - /design-system is dev-only: 404 in production
 * - API paths are never redirected
 *
 * Sliding sessions (docs/ACCOUNTS.md §5): a cookie that VERIFIES (signature + expiry, `session-token.ts`) and was
 * issued more than SESSION_RENEW_AFTER_HOURS ago is re-issued for another SESSION_TTL_DAYS on the response, whatever
 * its kind (next / redirect / API). Only on GET / HEAD and never under /api/auth/* or on `?expired`: those are the
 * requests whose handler sets or clears the cookie itself (sign-in, sign-out, password changes, server actions — all
 * POSTs), and a renewal there could overwrite their answer. An invalid cookie is left alone (the layouts send the
 * person to /login?expired=1). Static assets never reach the proxy (`config.matcher`).
 *
 * Every response also carries the security headers (`SECURITY_HEADERS`, DEMO-06): no framing by other sites (the
 * sign-in page's one-press demo buttons, My account's Disconnect / Log out of other devices — clickjacking), no MIME
 * sniffing, and only the origin in the Referer sent to other sites (invite / reset / confirm links carry tokens).
 * An address with broken percent-encoding (a mangled invite link) never reaches a route (DEMO-08: in production it
 * was a bare 500): the API answers a plain 400, an /invite/… page lands on the friendly dead-link card.
 */
import { decodeJwt } from "jose";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/constants";
import { renewSessionToken, sessionCookieOptions } from "@/server/auth/session-token";

// /api/system/cron/ authenticates with a bearer CRON_SECRET inside the route (server-to-server).
// Front door: the landing page, "Create your studio", forgot / reset password and invite links are public.
// Accounts (docs/ACCOUNTS-PLAN.md): the confirm pages (/verify-email, /change-email) work signed in or out, and
// /signup/google finishes a Google sign-up.
const PUBLIC_PREFIXES = [
  "/api/auth/",
  "/api/system/cron/",
  "/_next/",
  "/favicon",
  "/robots.txt",
  "/sitemap.xml",
  "/forgot-password",
  "/reset-password",
  "/invite/",
  "/verify-email",
  "/change-email",
  "/signup/google",
];
/** Sign in / Create your studio: public; a signed-in person gets the "You're signed in" notice there, not a redirect. */
const ENTRY_PAGES = ["/login", "/signup"];
const DESIGN_SYSTEM_PREFIX = "/design-system";
/** Never re-issue the session cookie here (handlers that manage the cookie themselves, and non-pages). */
const NO_RENEW_PREFIXES = ["/api/auth/", "/_next/", "/favicon", "/robots.txt", "/sitemap.xml"];

/** Sent with every response that passes the proxy (DEMO-06). `frame-ancestors` is the modern X-Frame-Options. */
export const SECURITY_HEADERS: readonly (readonly [string, string])[] = [
  ["X-Frame-Options", "DENY"],
  ["Content-Security-Policy", "frame-ancestors 'none'"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
];

/** Where a mangled invite link (broken percent-encoding) lands: a token that can never be valid → the dead-link card. */
export const MANGLED_INVITE_PATH = "/invite/link-not-valid";

/** False when the path has broken percent-encoding (`%E0%A4%A`): decoding it would throw inside the route. */
export function hasValidEncoding(pathname: string): boolean {
  try {
    decodeURIComponent(pathname);
    return true;
  } catch {
    return false;
  }
}

/** Staff landing pages (plan §3): editors live on My jobs, photographers on Home. */
export const STAFF_HOME = "/home";
export const EDITOR_HOME = "/my-jobs";
export const CLIENT_HOME = "/portal";

function startsWithAny(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => pathname === p.replace(/\/$/, "") || pathname.startsWith(p));
}

function isPublic(pathname: string): boolean {
  return startsWithAny(pathname, PUBLIC_PREFIXES);
}

function isDesignSystem(pathname: string): boolean {
  return pathname === DESIGN_SYSTEM_PREFIX || pathname.startsWith(`${DESIGN_SYSTEM_PREFIX}/`);
}

function isApi(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function isPortal(pathname: string): boolean {
  return pathname === "/portal" || pathname.startsWith("/portal/");
}

/** /login?expired=1 or /signup?expired=1: the stale cookie is being thrown away. */
function isExpiredEntry(req: NextRequest): boolean {
  return ENTRY_PAGES.includes(req.nextUrl.pathname) && req.nextUrl.searchParams.has("expired");
}

interface SessionHint {
  kind: "staff" | "client";
  role: "photographer" | "editor" | "client";
}

/** The `k` / `r` claims of the session cookie (unverified; missing / unreadable = staff photographer). */
export function sessionHintOf(token: string | undefined): SessionHint {
  const staff: SessionHint = { kind: "staff", role: "photographer" };
  if (!token) return staff;
  try {
    const claims = decodeJwt(token);
    if (claims.k === "client") return { kind: "client", role: "client" };
    return { kind: "staff", role: claims.r === "editor" ? "editor" : "photographer" };
  } catch {
    return staff;
  }
}

/** Where a signed-in person lands (plan §3). */
export function landingFor(hint: SessionHint): string {
  if (hint.kind === "client") return CLIENT_HOME;
  return hint.role === "editor" ? EDITOR_HOME : STAFF_HOME;
}

/**
 * May this request carry a renewed session cookie? GET / HEAD only (every handler that signs in or out is a POST),
 * never under /api/auth/* (their GETs — the Google round trip — set cookies themselves), never on `?expired`.
 */
export function mayRenewSession(req: NextRequest): boolean {
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  if (startsWithAny(req.nextUrl.pathname, NO_RENEW_PREFIXES)) return false;
  return !isExpiredEntry(req);
}

/** The routing decision (synchronous; no signature check). */
function route(req: NextRequest, token: string | undefined): NextResponse {
  const { pathname, search } = req.nextUrl;
  const hasCookie = Boolean(token);
  const hint = sessionHintOf(token);

  if (isDesignSystem(pathname)) {
    // Plan §8: the design-system page is dev-only (it was reachable without logging in).
    if (process.env.NODE_ENV === "production") return new NextResponse(null, { status: 404 });
    return NextResponse.next();
  }

  if (ENTRY_PAGES.includes(pathname)) {
    const res = NextResponse.next();
    if (hasCookie && isExpiredEntry(req)) res.cookies.delete(SESSION_COOKIE_NAME);
    return res;
  }

  if (isPublic(pathname)) return NextResponse.next();
  // The landing page is public for everyone (signed-in people included: no redirect, no portal bounce).
  if (pathname === "/") return NextResponse.next();

  if (hasCookie) {
    if (isApi(pathname)) return NextResponse.next();
    if (hint.kind === "client" && !isPortal(pathname)) return NextResponse.redirect(new URL(CLIENT_HOME, req.url));
    if (hint.kind === "staff" && isPortal(pathname)) return NextResponse.redirect(new URL(landingFor(hint), req.url));
    // The old "My Work" page: one list of jobs per persona (plan §1, §3).
    if (pathname === "/workspace/my") return NextResponse.redirect(new URL(hint.role === "editor" ? EDITOR_HOME : "/jobs", req.url));
    return NextResponse.next();
  }

  if (isApi(pathname)) {
    return NextResponse.json({ error: { code: "unauthorized", message: "Sign in required" } }, { status: 401 });
  }

  const login = new URL("/login", req.url);
  if (pathname !== STAFF_HOME && pathname !== "/dashboard") login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

/** A path with broken percent-encoding: 400 JSON for the API, the dead-link card for an invite page, else null. */
function mangledAddress(req: NextRequest): NextResponse | null {
  const { pathname } = req.nextUrl;
  if (hasValidEncoding(pathname)) return null;
  if (isApi(pathname)) {
    return NextResponse.json({ error: { code: "validation", message: "This address is not valid" } }, { status: 400 });
  }
  if (pathname.startsWith("/invite/")) return NextResponse.redirect(new URL(MANGLED_INVITE_PATH, req.url));
  return null;
}

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value || undefined;
  const mangled = mangledAddress(req);
  const res = mangled ?? route(req, token);
  if (!mangled && token && mayRenewSession(req)) {
    // null for an invalid / expired / still-fresh token: then the cookie is left exactly as it is.
    const renewed = await renewSessionToken(token);
    if (renewed) res.cookies.set(SESSION_COOKIE_NAME, renewed, sessionCookieOptions());
  }
  for (const [name, value] of SECURITY_HEADERS) res.headers.set(name, value);
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|woff2?)$).*)"],
};
