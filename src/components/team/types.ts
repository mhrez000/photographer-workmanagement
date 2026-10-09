import type { WorkloadBand } from "@/lib/constants";
import type { DirectoryStats, TeamRef, UserRef, WorkloadRow } from "@/lib/types";

/** One person on `/team/editors` or `/team/photographers` (serialisable for client islands). */
export interface DirectoryPerson {
  user: UserRef;
  email: string | null;
  title: string | null;
  teams: TeamRef[];
  /** null without workloads.view_team (except the viewer's own row). */
  stats: DirectoryStats | null;
  /** Editors only, when team workloads are visible. */
  workload: {
    band: WorkloadBand;
    ratio: number;
    bandReason: WorkloadRow["bandReason"];
    capacityHoursPerWeek: number;
    completedThisWeek: number;
  } | null;
  /** Photographers only (this month), when analytics are visible. */
  output: { submitted: number; completed: number; avgProcessingSeconds: number | null } | null;
}

export type DirectoryRole = "editor" | "photographer";

/** Per-person highlight computed server-side on `/team/performance` (meaningful, not vanity). */
export interface PerformanceFlag {
  /** Why this person stands out positively (null = not a highlight). */
  top: string | null;
  /** Reasons this row needs attention (empty = fine). */
  attention: string[];
}
