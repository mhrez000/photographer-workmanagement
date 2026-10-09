import "server-only";
import type { DbLike } from "@/db";
import type { DirectoryPerson, DirectoryRole } from "@/components/team/types";
import type { AuthContext } from "@/lib/types";
import { can } from "@/server/auth/permissions";
import { getAnalyticsPhotographers } from "@/server/queries/analytics";
import { getDirectory } from "@/server/queries/users";
import { canViewTeamWorkloads, getWorkloads } from "@/server/queries/workloads";

/**
 * Directory rows for `/team/editors` and `/team/photographers`: the
 * directory entry plus (when the viewer may see them) the editor's workload
 * band / capacity and the photographer's output this month. Every figure
 * comes from an existing permission-checked query.
 */
export function loadDirectory(db: DbLike, ctx: AuthContext, role: DirectoryRole): { people: DirectoryPerson[]; showStats: boolean } {
  const entries = getDirectory(db, ctx, role);
  const showStats = canViewTeamWorkloads(ctx);

  const workloads = role === "editor" ? new Map(getWorkloads(db, ctx).map((w) => [w.editor.id, w])) : new Map();
  const output =
    role === "photographer" && can(ctx, "analytics.view")
      ? new Map(getAnalyticsPhotographers(db, ctx, { range: "this_month" }).photographers.map((p) => [p.user.id, p]))
      : new Map();

  const people: DirectoryPerson[] = entries.map((e) => {
    const w = workloads.get(e.user.id);
    const o = output.get(e.user.id);
    return {
      user: e.user,
      email: e.email,
      title: e.title,
      teams: e.teams,
      stats: e.stats,
      workload: w
        ? { band: w.band, ratio: w.ratio, bandReason: w.bandReason, capacityHoursPerWeek: w.editor.capacityHoursPerWeek, completedThisWeek: w.completedThisWeek }
        : null,
      output: o ? { submitted: o.submitted, completed: o.completed, avgProcessingSeconds: o.avgProcessingSeconds } : null,
    };
  });

  // Active people first (alphabetical), deactivated last.
  people.sort((a, b) => Number(b.user.isActive) - Number(a.user.isActive) || a.user.name.localeCompare(b.user.name));
  return { people, showStats };
}
