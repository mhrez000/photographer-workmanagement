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

function isPortalPath(p: string): boolean {
  return p === "/portal" || p.startsWith("/portal/") || p.startsWith("/portal?");
}

export function loginRedirectTarget(role: Role, next: unknown): string {
  const safe =
    typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") && !next.startsWith("/login")
      ? next
      : null;
  if (role === "client") return safe && isPortalPath(safe) ? safe : PORTAL_HOME;
  if (safe && !isPortalPath(safe) && safe !== "/dashboard") return safe;
  return role === "editor" ? EDITOR_HOME : STAFF_HOME;
}
