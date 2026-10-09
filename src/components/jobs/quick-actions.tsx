"use client";

import * as React from "react";
import { BadgeCheck, Ellipsis, ExternalLink, Pause, Play, RotateCcw, Send, UserPlus, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api-client";
import { CATEGORY_GROUPS, MANAGEMENT_ROLES, type Role, type StatusCategory } from "@/lib/constants";
import type { JobAvailableActions, JobRow, WorkSessionView } from "@/lib/types";
import { useJobActionController, moveKey, moveTargetCategory, type JobMove } from "./job-action-controller";
import { JobActionBar } from "./job-actions";
import { jobHref } from "./job-link";
import { TimerControl } from "./timer-control";

type QuickJob = Pick<JobRow, "id" | "version" | "jobNumber" | "name" | "statusCategory" | "isPaused" | "editor" | "photographer"> & {
  status?: JobRow["status"];
};

export interface JobQuickActionsProps {
  job: QuickJob;
  /** The signed-in user (decides the guessed next step when `actions` is not loaded). */
  viewer: { id: string; role: Role };
  timeTrackingEnabled: boolean;
  /** The viewer's running session, if it is on this job. */
  runningSession?: Pick<WorkSessionView, "id" | "startedAt"> | null;
  /** Server-computed actions when the page has them (then this renders JobActionBar compact). */
  actions?: JobAvailableActions;
  timeZone?: string;
  className?: string;
}

interface Guess {
  move?: JobMove;
  assign?: boolean;
  resume?: boolean;
  icon: LucideIcon;
  label: string;
}

const EDITOR_NEXT: Partial<Record<StatusCategory, { to: StatusCategory; label: string; icon: LucideIcon }>> = {
  assigned: { to: "in_progress", label: "Start", icon: Play },
  accepted: { to: "in_progress", label: "Start", icon: Play },
  in_progress: { to: "submitted", label: "Submit", icon: Send },
  revision: { to: "resubmitted", label: "Resubmit", icon: Send },
};

const REVIEWER_NEXT: Partial<Record<StatusCategory, { to: StatusCategory; label: string; icon: LucideIcon }>> = {
  submitted: { to: "approved", label: "Approve", icon: BadgeCheck },
  review: { to: "approved", label: "Approve", icon: BadgeCheck },
  resubmitted: { to: "approved", label: "Approve", icon: BadgeCheck },
};

function guessNext(job: QuickJob, viewer: { id: string; role: Role }): Guess | null {
  const isEditor = job.editor?.id === viewer.id;
  const isManager = MANAGEMENT_ROLES.includes(viewer.role);
  const isOwnPhotographer = viewer.role === "photographer" && job.photographer?.id === viewer.id;
  if (job.isPaused && (isEditor || isManager)) return { resume: true, label: "Resume", icon: Play };
  if (isEditor && EDITOR_NEXT[job.statusCategory]) {
    const n = EDITOR_NEXT[job.statusCategory]!;
    return { move: { toCategory: n.to, label: n.label, isReopen: false, requiresReason: false, requiresRevisionPayload: false }, label: n.label, icon: n.icon };
  }
  if ((isManager || isOwnPhotographer) && REVIEWER_NEXT[job.statusCategory]) {
    const n = REVIEWER_NEXT[job.statusCategory]!;
    return { move: { toCategory: n.to, label: n.label, isReopen: false, requiresReason: false, requiresRevisionPayload: false }, label: n.label, icon: n.icon };
  }
  if ((isManager || isOwnPhotographer) && !job.editor && CATEGORY_GROUPS.UNASSIGNED.includes(job.statusCategory)) {
    return { assign: true, label: "Assign", icon: UserPlus };
  }
  return null;
}

type Loaded = { state: "idle" } | { state: "loading" } | { state: "ready"; moves: JobMove[] } | { state: "error"; message: string };

/**
 * Card-sized actions (My Work, Kanban, Team Work): one primary button for the
 * obvious next step + an overflow menu whose moves load on demand from
 * `GET /api/jobs/:id/transitions`. With `actions` it defers to JobActionBar.
 */
export function JobQuickActions(props: JobQuickActionsProps) {
  if (props.actions) {
    const { job, actions, timeTrackingEnabled, runningSession, timeZone, className } = props;
    return (
      <JobActionBar
        layout="compact"
        jobId={job.id}
        version={job.version}
        actions={actions}
        job={{ statusCategory: job.statusCategory, isPaused: job.isPaused, editor: job.editor, photographer: job.photographer, jobNumber: job.jobNumber, name: job.name }}
        timeTrackingEnabled={timeTrackingEnabled}
        runningSession={runningSession ?? null}
        timeZone={timeZone}
        className={className}
      />
    );
  }
  return <GuessedQuickActions {...props} />;
}

function GuessedQuickActions({ job, viewer, timeTrackingEnabled, runningSession, timeZone, className }: JobQuickActionsProps) {
  const isEditor = job.editor?.id === viewer.id;
  const canUseTimer = timeTrackingEnabled && isEditor && CATEGORY_GROUPS.EDITOR_WORKING.concat(["assigned"]).includes(job.statusCategory);
  const controller = useJobActionController({
    jobId: job.id,
    version: job.version,
    job: { statusCategory: job.statusCategory, isPaused: job.isPaused, editor: job.editor, photographer: job.photographer, jobNumber: job.jobNumber, name: job.name },
    timeTrackingEnabled,
    canUseTimer,
    canAssignEditor: MANAGEMENT_ROLES.includes(viewer.role) || (viewer.role === "photographer" && job.photographer?.id === viewer.id),
    timeZone,
  });
  const guess = guessNext(job, viewer);
  const [loaded, setLoaded] = React.useState<Loaded>({ state: "idle" });

  const loadMoves = async () => {
    if (loaded.state === "loading" || loaded.state === "ready") return;
    setLoaded({ state: "loading" });
    try {
      const res = await api.get<{ transitions: JobAvailableActions["transitions"] }>(`/api/jobs/${job.id}/transitions`);
      const moves = (res?.transitions ?? []).map(
        (t): JobMove => ({
          toStatus: t.toStatus,
          toStatusId: t.toStatus.id,
          label: t.label,
          isReopen: t.isReopen,
          requiresReason: t.requiresReason,
          requiresRevisionPayload: t.requiresRevisionPayload,
        }),
      );
      setLoaded({ state: "ready", moves });
    } catch (err) {
      setLoaded({ state: "error", message: err instanceof Error ? err.message : "Could not load actions" });
    }
  };

  const runGuess = () => {
    if (!guess) return;
    if (guess.resume) void controller.pauseOrResume("resume");
    else if (guess.assign) controller.openAssign();
    else if (guess.move) controller.startMove(guess.move);
  };
  const guessKey = guess?.resume ? "resume" : guess?.move ? moveKey(guess.move) : "assign";

  const menuMoves =
    loaded.state === "ready"
      ? loaded.moves.filter((m) => {
          const to = moveTargetCategory(m);
          if (to === "assigned" || (to === "ready" && job.statusCategory !== "new" && job.statusCategory !== "assigned")) return false;
          return !(guess?.move && guess.move.toCategory === to);
        })
      : [];
  const canPauseGuess = isEditor && !job.isPaused && CATEGORY_GROUPS.EDITOR_WORKING.includes(job.statusCategory);

  return (
    <div className={className} onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-1.5">
        {guess ? (
          <Button
            size="sm"
            variant="primary"
            leadingIcon={<guess.icon />}
            loading={controller.busy === guessKey}
            disabled={controller.busy !== null && controller.busy !== guessKey}
            onClick={runGuess}
          >
            {guess.label}
          </Button>
        ) : null}
        {canUseTimer && (runningSession || CATEGORY_GROUPS.EDITOR_WORKING.includes(job.statusCategory)) ? (
          <TimerControl jobId={job.id} runningSession={runningSession ?? null} enabled size="sm" compact />
        ) : null}
        <DropdownMenu onOpenChange={(open) => (open ? void loadMoves() : undefined)}>
          <DropdownMenuTrigger variant="ghost" size="sm" aria-label={`More actions for ${job.jobNumber}`} className="w-8 px-0">
            <Ellipsis aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" width="14rem" aria-label="Job actions">
            {loaded.state === "loading" || loaded.state === "idle" ? (
              <div className="flex items-center gap-2 px-2.5 py-2 text-sm text-ink-muted">
                <Spinner size="xs" /> Loading actions…
              </div>
            ) : loaded.state === "error" ? (
              <p className="px-2.5 py-2 text-sm text-danger">{loaded.message}</p>
            ) : (
              menuMoves.map((m) => (
                <DropdownMenuItem
                  key={moveKey(m)}
                  icon={m.isReopen || moveTargetCategory(m) === "revision" ? <RotateCcw /> : <Send />}
                  destructive={moveTargetCategory(m) === "cancelled"}
                  onSelect={() => controller.startMove(m)}
                >
                  {moveTargetCategory(m) === "cancelled" ? "Cancel job…" : m.label}
                </DropdownMenuItem>
              ))
            )}
            {canPauseGuess ? (
              <DropdownMenuItem icon={<Pause />} onSelect={() => void controller.pauseOrResume("pause")}>
                Pause job
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<ExternalLink />} href={jobHref(job.id)}>
              Open job
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {controller.dialogs}
    </div>
  );
}
