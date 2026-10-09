import type { LucideIcon } from "lucide-react";
import { CalendarX2, Hourglass, Inbox, PauseCircle, RotateCcw, UserX, Weight } from "lucide-react";
import type { BottleneckKind } from "@/lib/constants";
import type { OrganisationSettings } from "@/lib/types";

export interface BottleneckMeta {
  label: string;
  icon: LucideIcon;
  /** Plain-language rule with the organisation's thresholds filled in. */
  rule: (s: OrganisationSettings) => string;
  /** What to do about it. */
  fix: string;
}

const h = (n: number) => `${n}h`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Copy + icon per bottleneck rule (ARCHITECTURE.md §8 "Bottlenecks"). */
export const BOTTLENECK_META: Record<BottleneckKind, BottleneckMeta> = {
  review: {
    label: "Review bottleneck",
    icon: Hourglass,
    rule: (s) => `${plural(s.reviewBottleneckMinJobs, "job")} or more waiting for review longer than ${h(s.reviewBottleneckHours)}.`,
    fix: "Clear the review queue, or delegate reviews to another manager.",
  },
  editor_overloaded: {
    label: "Editing bottleneck",
    icon: Weight,
    rule: (s) =>
      `An editor is overloaded, or holds ${s.maxActiveJobsPerEditor}+ active jobs with ${s.editingBottleneckMinDueSoon}+ due within ${h(s.editingBottleneckDueWithinHours)}.`,
    fix: "Move jobs that haven't started to someone with headroom.",
  },
  revision_spike: {
    label: "Revision spike",
    icon: RotateCcw,
    rule: (s) => `${s.revisionSpikeMinCount}+ revisions requested in the last 7 days and at least ${s.revisionSpikeMultiplier}× the 4-week weekly average.`,
    fix: "Look for a common cause — one client, one job type, unclear briefs.",
  },
  unassigned_backlog: {
    label: "Unassigned backlog",
    icon: Inbox,
    rule: (s) => `${s.unassignedBacklogMin}+ jobs waiting for an editor, or any unassigned job due within 48h.`,
    fix: "Assign the jobs due soonest first.",
  },
  stalled: {
    label: "Stalled jobs",
    icon: PauseCircle,
    rule: (s) => `Active, not paused, and no activity for ${plural(s.stalledDays, "day")}.`,
    fix: "Check in with whoever holds them, or pause them with a reason.",
  },
  editor_unavailable: {
    label: "Editor unavailable",
    icon: UserX,
    rule: () => "Active jobs assigned to a deactivated editor.",
    fix: "Reassign them from Workloads in one go.",
  },
  review_overdue: {
    label: "Review deadlines passed",
    icon: CalendarX2,
    rule: () => "Jobs waiting on review past their review due date.",
    fix: "Review these first — the client deadline is at risk.",
  },
};
