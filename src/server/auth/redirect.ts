/**
 * Post-login landing (docs/ROLES.md §7.8): clients only inside /portal; staff
 * never in /portal. Only same-site relative paths are honoured for `next`
 * (no open redirects).
 */
import type { Role } from "@/lib/constants";

function isPortalPath(p: string): boolean {
  return p === "/portal" || p.startsWith("/portal/") || p.startsWith("/portal?");
}

export function loginRedirectTarget(role: Role, next: unknown): string {
  const safe =
    typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") && !next.startsWith("/login")
      ? next
      : null;
  if (role === "client") return safe && isPortalPath(safe) ? safe : "/portal";
  return safe && !isPortalPath(safe) ? safe : "/dashboard";
}
