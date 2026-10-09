"use client";

import * as React from "react";
import {
  ArchiveRestore,
  ArrowRight,
  Ban,
  BadgeCheck,
  Check,
  CircleCheckBig,
  Ellipsis,
  Hand,
  PackageCheck,
  Pause,
  Play,
  RotateCcw,
  Send,
  Shuffle,
  Undo2,
  UserPlus,
  UserRoundCog,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { StatusCategory } from "@/lib/constants";
import type { JobAvailableActions, StatusRef, WorkSessionView } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  moveKey,
  moveTargetCategory,
  useJobActionController,
  type ActionJobSummary,
  type JobActionController,
  type JobMove,
} from "./job-action-controller";
import { TimerControl } from "./timer-control";

/**
 * Next-step targets per current category, best first (spec §4 workflow).
 * The first match renders as the primary button, the second as secondary.
 */
const PRIMARY_TARGETS: Record<StatusCategory, readonly StatusCategory[]> = {
  new: ["ready"],
  ready: [],
  assigned: ["in_progress", "accepted"],
  accepted: ["in_progress"],
  in_progress: ["submitted"],
  submitted: ["approved", "revision"],
  review: ["approved", "revision"],
  resubmitted: ["approved", "revision"],
  revision: ["resubmitted"],
  approved: ["delivered", "completed"],
  delivered: ["completed"],
  completed: ["in_progress"],
  cancelled: [],
};

const TARGET_ICONS: Partial<Record<StatusCategory, LucideIcon>> = {
  new: Undo2,
  ready: ArrowRight,
  accepted: Check,
  in_progress: Play,
  submitted: Send,
  review: Hand,
  revision: RotateCcw,
  resubmitted: Send,
  approved: BadgeCheck,
  delivered: PackageCheck,
  completed: CircleCheckBig,
  cancelled: Ban,
};

/** One rendered action (button or menu item). */
export interface PlannedAction {
  key: string;
  label: string;
  icon: LucideIcon;
  run: () => void;
  destructive?: boolean;
  /** Outline instead of filled when shown as the main button (reopen / restore). */
  subtle?: boolean;
}

export interface ActionPlan {
  primary: PlannedAction[];
  overflow: PlannedAction[];
  management: PlannedAction[];
  danger: PlannedAction[];
}

interface PlanInput {
  actions: JobAvailableActions;
  job: ActionJobSummary;
  controller: JobActionController;
  canOverride: boolean;
}

function toMove(t: JobAvailableActions["transitions"][number]): JobMove {
  return {
    toStatus: t.toStatus,
    toStatusId: t.toStatus.id,
    label: t.label,
    isReopen: t.isReopen,
    requiresRevisionPayload: t.requiresRevisionPayload,
    requiresReason: t.requiresReason,
  };
}

/** Decide which actions are primary and which go to the overflow menu. */
export function planJobActions({ actions, job, controller, canOverride }: PlanInput): ActionPlan {
  const current = job.statusCategory;
  const moves = actions.transitions.map(toMove).filter((m) => {
    const to = moveTargetCategory(m);
    // Assignment edges are side effects of assignEditor — offered as Assign/Unassign instead.
    if (to === "assigned" && current !== "assigned") return false;
    if (to === "ready" && current !== "new") {
      // "Decline" is the editor's move; people who can assign use Unassign.
      if (current !== "assigned" || actions.canAssignEditor) return false;
    }
    return true;
  });

  const asAction = (m: JobMove): PlannedAction => {
    const to = moveTargetCategory(m);
    const restore = current === "cancelled";
    return {
      key: moveKey(m),
      label: m.label,
      icon: restore ? ArchiveRestore : m.isReopen ? RotateCcw : (to && TARGET_ICONS[to]) || ArrowRight,
      run: () => controller.startMove(m),
      destructive: to === "cancelled",
      subtle: m.isReopen || restore,
    };
  };

  const cancelMoves = moves.filter((m) => moveTargetCategory(m) === "cancelled");
  const workMoves = moves.filter((m) => moveTargetCategory(m) !== "cancelled");

  const primaryMoves: JobMove[] = [];
  if (current === "cancelled") {
    primaryMoves.push(...workMoves.slice(0, 1));
  } else {
    for (const target of PRIMARY_TARGETS[current]) {
      const m = workMoves.find((x) => moveTargetCategory(x) === target && !primaryMoves.includes(x));
      if (m) primaryMoves.push(m);
    }
  }

  const primary: PlannedAction[] = [];
  const overflow: PlannedAction[] = [];
  const management: PlannedAction[] = [];

  // Paused jobs: resuming comes first.
  if (job.isPaused && actions.canResume) {
    primary.push({ key: "resume", label: "Resume", icon: Play, run: () => void controller.pauseOrResume("resume") });
  }

  // Unassigned jobs: assigning an editor is the next step.
  const needsEditor = !job.editor && (current === "new" || current === "ready");
  if (needsEditor && actions.canAssignEditor) {
    primary.push({ key: "assign", label: "Assign editor", icon: UserPlus, run: () => controller.openAssign() });
  }

  primary.push(...primaryMoves.map(asAction));
  overflow.push(...workMoves.filter((m) => !primaryMoves.includes(m)).map(asAction));

  if (!job.isPaused && actions.canPause) {
    overflow.push({ key: "pause", label: "Pause job", icon: Pause, run: () => void controller.pauseOrResume("pause") });
  }

  if (actions.canAssignEditor && !(needsEditor && primary.some((p) => p.key === "assign"))) {
    management.push({
      key: "assign",
      label: job.editor ? "Reassign editor…" : "Assign editor…",
      icon: job.editor ? UserRoundCog : UserPlus,
      run: () => controller.openAssign(),
    });
  }
  if (canOverride && current !== "cancelled") {
    management.push({ key: "override", label: "Move to any status…", icon: Shuffle, run: () => controller.openOverride() });
  }

  const danger = cancelMoves.map((m) => ({ ...asAction(m), label: "Cancel job…" }));

  return { primary, overflow, management, danger };
}

export interface JobActionBarProps {
  jobId: string;
  /** Job version for optimistic concurrency (`expectedVersion`). */
  version: number;
  /** Server-computed actions for the current actor (JobDetail.actions). */
  actions: JobAvailableActions;
  job: ActionJobSummary;
  /** Org setting `time_tracking_enabled`. */
  timeTrackingEnabled: boolean;
  /** The actor's running session on this job (JobDetail.runningSession when it is theirs). */
  runningSession: Pick<WorkSessionView, "id" | "startedAt"> | null;
  /** "bar" = header row with up to two buttons; "compact" = one small button + menu (cards). */
  layout?: "bar" | "compact";
  /** Org timezone (dates in dialogs). */
  timeZone?: string;
  /** Workflow statuses — enables the manager "Move to any status" override. */
  workflowStatuses?: StatusRef[];
  /** Actor may use `job.transition_override` (owners / managers). */
  canOverride?: boolean;
  className?: string;
}

/**
 * The job's next-step buttons (chosen by status category) plus an overflow
 * menu with everything else the actor may do. Every action posts to the REST
 * API with `expectedVersion`, handles follow-up dialogs, then refreshes.
 */
export function JobActionBar({
  jobId,
  version,
  actions,
  job,
  timeTrackingEnabled,
  runningSession,
  layout = "bar",
  timeZone,
  workflowStatuses,
  canOverride = false,
  className,
}: JobActionBarProps) {
  const controller = useJobActionController({
    jobId,
    version,
    job,
    timeTrackingEnabled,
    canUseTimer: actions.canUseTimer,
    canAssignEditor: actions.canAssignEditor,
    timeZone,
    workflowStatuses: canOverride ? workflowStatuses : undefined,
  });
  const plan = planJobActions({ actions, job, controller, canOverride: canOverride && Boolean(workflowStatuses?.length) });
  const compact = layout === "compact";

  const shownPrimary = compact ? plan.primary.slice(0, 1) : plan.primary.slice(0, 2);
  const spill = plan.primary.slice(shownPrimary.length);
  const menuSections = [[...spill, ...plan.overflow], plan.management, plan.danger].filter((s) => s.length > 0);
  const timerEnabled = timeTrackingEnabled && actions.canUseTimer;

  return (
    <div
      className={cn("flex flex-wrap items-center gap-2", compact && "flex-nowrap gap-1.5", className)}
      onClick={compact ? (e) => e.stopPropagation() : undefined}
    >
      {shownPrimary.map((action, index) => (
        <Button
          key={action.key}
          size={compact ? "sm" : "md"}
          variant={index === 0 && !action.subtle ? "primary" : "outline"}
          leadingIcon={<action.icon />}
          loading={controller.busy === action.key}
          disabled={controller.busy !== null && controller.busy !== action.key}
          onClick={action.run}
          className={cn(!compact && "max-sm:flex-1")}
        >
          {action.label}
        </Button>
      ))}

      {timerEnabled && (!compact || runningSession) ? (
        <TimerControl jobId={jobId} runningSession={runningSession} enabled size={compact ? "sm" : "md"} compact={compact} />
      ) : null}

      {menuSections.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            variant={compact ? "ghost" : "outline"}
            size={compact ? "sm" : "md"}
            aria-label="More actions"
            className={cn(compact ? "w-8 px-0" : "w-9 px-0")}
          >
            <Ellipsis aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" width="15rem" aria-label="More job actions">
            {menuSections.map((section, i) => (
              <React.Fragment key={i}>
                {i > 0 ? <DropdownMenuSeparator /> : null}
                {i === 1 && section === plan.management ? <DropdownMenuLabel>Manage</DropdownMenuLabel> : null}
                {section.map((action) => (
                  <DropdownMenuItem
                    key={action.key}
                    icon={<action.icon />}
                    destructive={action.destructive}
                    onSelect={action.run}
                    disabled={controller.busy !== null}
                  >
                    {action.label}
                  </DropdownMenuItem>
                ))}
              </React.Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : shownPrimary.length === 0 && !timerEnabled && !compact ? (
        <p className="text-sm text-ink-muted">No actions available to you at this stage.</p>
      ) : null}

      {controller.dialogs}
    </div>
  );
}
