import type { AuthContext } from "@/lib/types";
import { isManagement } from "@/server/auth/permissions";

/**
 * Who may open Team Work (ARCHITECTURE §10: managers; photographers / editors
 * only when the organisation lets them see team jobs). Rows are still
 * visibility-scoped by `getTeamWork`; this is the page-level gate.
 */
export function canViewTeamWork(ctx: AuthContext): boolean {
  if (!ctx.isActive) return false;
  if (isManagement(ctx)) return true;
  if (ctx.role === "photographer") return ctx.settings.photographersSeeTeamJobs || ctx.settings.photographersSeeAllJobs;
  if (ctx.role === "editor") return ctx.settings.editorsSeeTeamJobs;
  return false;
}
