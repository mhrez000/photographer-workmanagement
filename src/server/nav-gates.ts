/**
 * Navigation gates (docs/ROLES.md §10, docs/SIMPLIFICATION-PLAN.md §3), computed server-side with
 * `can()` and passed to the shell (`navigationFor(gates)` in src/config/nav.ts). UI hiding is never
 * the boundary: every page and API re-checks (`requireAdvanced` for the hidden pages).
 */
import type { NavGates } from "@/config/nav";
import type { AuthContext } from "@/lib/types";
import { advancedToolsOn, can, isAdmin } from "@/server/auth/permissions";

/** Team Work page gate: admins, members with "See all jobs", editors with "See other editors' jobs" (§10.1). */
export function canViewTeamWork(ctx: AuthContext): boolean {
  if (!ctx.isActive || ctx.role === "client") return false;
  if (isAdmin(ctx)) return true;
  if (ctx.role === "photographer") return ctx.canViewAllJobs;
  return ctx.role === "editor" && ctx.canViewTeamJobs;
}

export function navGatesFor(ctx: AuthContext): NavGates {
  const staff = ctx.isActive && !ctx.isSystem && ctx.role !== "client";
  const admin = staff && isAdmin(ctx);
  const photographer = staff && ctx.role === "photographer";
  return {
    admin,
    createJobs: can(ctx, "job.create"),
    createClients: can(ctx, "client.create"),
    teamWork: canViewTeamWork(ctx),
    directory: can(ctx, "team.view_members"),
    teamWorkloads: can(ctx, "workloads.view_team"),
    analytics: can(ctx, "analytics.view"),
    photographer,
    editor: staff && ctx.role === "editor",
    newJob: photographer && can(ctx, "job.create"),
    // The Advanced group is the owner's (plan §3); the switch itself is the studio's (plan §8).
    advanced: admin && advancedToolsOn(ctx),
  };
}
