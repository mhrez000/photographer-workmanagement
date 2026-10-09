/**
 * Edge gate (Next 16 `proxy`, ARCHITECTURE.md §3.3). Cookie PRESENCE only —
 * no DB, no signature check; `requireContext()` is the real boundary.
 *
 * - no session cookie on an app page → redirect to /login?next=<path>
 * - no session cookie on /api/* (except /api/auth/*) → 401 JSON
 * - session cookie on /login → redirect to /dashboard, unless `?expired=1`
 *   (set by the app layout when the cookie is stale/revoked): then the
 *   cookie is deleted and the login page renders — no redirect loop
 */
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/constants";

const PUBLIC_PREFIXES = ["/api/auth/", "/_next/", "/design-system", "/favicon", "/robots.txt", "/sitemap.xml"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p.replace(/\/$/, "") || pathname.startsWith(p));
}

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const hasCookie = Boolean(req.cookies.get(SESSION_COOKIE_NAME)?.value);

  if (pathname === "/login") {
    if (req.nextUrl.searchParams.has("expired")) {
      const res = NextResponse.next();
      if (hasCookie) res.cookies.delete(SESSION_COOKIE_NAME);
      return res;
    }
    if (hasCookie) return NextResponse.redirect(new URL("/dashboard", req.url));
    return NextResponse.next();
  }

  if (isPublic(pathname) || hasCookie) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: { code: "unauthorized", message: "Sign in required" } }, { status: 401 });
  }

  const login = new URL("/login", req.url);
  if (pathname !== "/" && pathname !== "/dashboard") login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|woff2?)$).*)"],
};
