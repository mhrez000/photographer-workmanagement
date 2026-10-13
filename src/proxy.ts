/**
 * Edge gate (Next 16 `proxy`, ARCHITECTURE.md §3.3, docs/ROLES.md §7.8, docs/SIMPLIFICATION-PLAN.md §3).
 * Cookie PRESENCE plus the UNVERIFIED session claims `k` (kind) and `r` (role) — no DB, no signature
 * check. Routing only: `requireContext()` / `requirePortalContext()` and the (app) / portal layouts are
 * the real boundary.
 *
 * - no session cookie on an app page → redirect to /login?next=<path>
 * - no session cookie on /api/* (except /api/auth/*) → 401 JSON
 * - session cookie on /login → the persona's landing page (clients /portal, editors /my-jobs, else
 *   /home), unless `?expired=1` (set by the layouts when the cookie is stale/revoked): then the cookie
 *   is deleted and the login page renders — no redirect loop
 * - client cookie on a staff page → /portal; staff cookie on /portal* → the staff landing page
 * - /workspace/my (the old "My Work") → /my-jobs for editors, /jobs for everyone else
 * - /design-system is dev-only: 404 in production
 * - API paths are never redirected
 */
import { decodeJwt } from "jose";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/constants";

// /api/system/cron/ authenticates with a bearer CRON_SECRET inside the route (server-to-server).
const PUBLIC_PREFIXES = ["/api/auth/", "/api/system/cron/", "/_next/", "/favicon", "/robots.txt", "/sitemap.xml"];
const DESIGN_SYSTEM_PREFIX = "/design-system";

/** Staff landing pages (plan §3): editors live on My jobs, photographers on Home. */
export const STAFF_HOME = "/home";
export const EDITOR_HOME = "/my-jobs";
export const CLIENT_HOME = "/portal";

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p.replace(/\/$/, "") || pathname.startsWith(p));
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

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const hasCookie = Boolean(token);
  const hint = sessionHintOf(token);

  if (isDesignSystem(pathname)) {
    // Plan §8: the design-system page is dev-only (it was reachable without logging in).
    if (process.env.NODE_ENV === "production") return new NextResponse(null, { status: 404 });
    return NextResponse.next();
  }

  if (pathname === "/login") {
    if (req.nextUrl.searchParams.has("expired")) {
      const res = NextResponse.next();
      if (hasCookie) res.cookies.delete(SESSION_COOKIE_NAME);
      return res;
    }
    if (hasCookie) return NextResponse.redirect(new URL(landingFor(hint), req.url));
    return NextResponse.next();
  }

  if (isPublic(pathname)) return NextResponse.next();

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
  if (pathname !== "/" && pathname !== STAFF_HOME && pathname !== "/dashboard") login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|woff2?)$).*)"],
};
