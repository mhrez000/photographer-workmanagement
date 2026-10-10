/**
 * Navigation gates (docs/ROLES.md §10), computed server-side with `can()` and
 * passed to the shell (`navigationFor(gates)` in src/config/nav.ts). UI hiding
 * is never the boundary: every page and API re-checks.
 */
import type { NavGates } from "@/config/nav";
import type { AuthContext } from "@/lib/types";
import { can, isAdmin } from "@/server/auth/permissions";

/** Team Work page gate: admins, members with "See all jobs", editors with "See other editors' jobs" (§10.1). */
export function canViewTeamWork(ctx: AuthContext): boolean {
  if (!ctx.isActive || ctx.role === "client") return false;
  if (isAdmin(ctx)) return true;
  if (ctx.role === "photographer") return ctx.canViewAllJobs;
  return ctx.role === "editor" && ctx.canViewTeamJobs;
}

export function navGatesFor(ctx: AuthContext): NavGates {
  return {
    admin: ctx.isActive && !ctx.isSystem && isAdmin(ctx),
    createJobs: can(ctx, "job.create"),
    createClients: can(ctx, "client.create"),
    teamWork: canViewTeamWork(ctx),
    directory: can(ctx, "team.view_members"),
    teamWorkloads: can(ctx, "workloads.view_team"),
    analytics: can(ctx, "analytics.view"),
  };
}
