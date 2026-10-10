/**
 * Edge gate (Next 16 `proxy`, ARCHITECTURE.md §3.3, docs/ROLES.md §7.8).
 * Cookie PRESENCE plus the UNVERIFIED session-kind claim `k` — no DB, no
 * signature check. Routing only: `requireContext()` / `requirePortalContext()`
 * and the (app) / portal layouts are the real boundary.
 *
 * - no session cookie on an app page → redirect to /login?next=<path>
 * - no session cookie on /api/* (except /api/auth/*) → 401 JSON
 * - session cookie on /login → /portal for clients, /dashboard for staff,
 *   unless `?expired=1` (set by the layouts when the cookie is stale/revoked):
 *   then the cookie is deleted and the login page renders — no redirect loop
 * - client cookie on a staff page → /portal; staff cookie on /portal* → /dashboard
 * - API paths are never redirected
 */
import { decodeJwt } from "jose";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/constants";

// /api/system/cron/ authenticates with a bearer CRON_SECRET inside the route (server-to-server).
const PUBLIC_PREFIXES = ["/api/auth/", "/api/system/cron/", "/_next/", "/design-system", "/favicon", "/robots.txt", "/sitemap.xml"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p.replace(/\/$/, "") || pathname.startsWith(p));
}

function isApi(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function isPortal(pathname: string): boolean {
  return pathname === "/portal" || pathname.startsWith("/portal/");
}

/** The `k` claim of the session cookie (unverified; a missing / unreadable claim = staff). */
function sessionKindOf(token: string | undefined): "staff" | "client" {
  if (!token) return "staff";
  try {
    return decodeJwt(token).k === "client" ? "client" : "staff";
  } catch {
    return "staff";
  }
}

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const hasCookie = Boolean(token);
  const kind = sessionKindOf(token);

  if (pathname === "/login") {
    if (req.nextUrl.searchParams.has("expired")) {
      const res = NextResponse.next();
      if (hasCookie) res.cookies.delete(SESSION_COOKIE_NAME);
      return res;
    }
    if (hasCookie) return NextResponse.redirect(new URL(kind === "client" ? "/portal" : "/dashboard", req.url));
    return NextResponse.next();
  }

  if (isPublic(pathname)) return NextResponse.next();

  if (hasCookie) {
    if (isApi(pathname)) return NextResponse.next();
    if (kind === "client" && !isPortal(pathname)) return NextResponse.redirect(new URL("/portal", req.url));
    if (kind === "staff" && isPortal(pathname)) return NextResponse.redirect(new URL("/dashboard", req.url));
    return NextResponse.next();
  }

  if (isApi(pathname)) {
    return NextResponse.json({ error: { code: "unauthorized", message: "Sign in required" } }, { status: 401 });
  }

  const login = new URL("/login", req.url);
  if (pathname !== "/" && pathname !== "/dashboard") login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|woff2?)$).*)"],
};
