"use client";

import * as React from "react";
import { Pause, Play, Square } from "lucide-react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { useNow } from "@/hooks/use-now";
import { api, ApiError } from "@/lib/api-client";
import type { WorkSessionView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useMutationRunner } from "./mutation";

/** "1:04:09" / "4:09" from seconds. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

export interface TimerControlProps {
  jobId: string;
  /** The actor's running session on this job (null = not running). */
  runningSession: Pick<WorkSessionView, "id" | "startedAt"> | null;
  /** Org has time tracking on and the actor may use the timer on this job. */
  enabled: boolean;
  size?: "sm" | "md";
  /** Icon-only buttons (cards). */
  compact?: boolean;
  className?: string;
}

/** Live elapsed time of a running session, ticking every second. */
export function ElapsedClock({ startedAt, className }: { startedAt: string; className?: string }) {
  const now = useNow(1000);
  const started = new Date(startedAt).getTime();
  const seconds = now === null || Number.isNaN(started) ? null : (now - started) / 1000;
  return (
    <span className={cn("font-mono numeric", className)} aria-live="off">
      {seconds === null ? "–:––" : formatClock(seconds)}
    </span>
  );
}

/**
 * Start / pause / stop the actor's work timer on a job, with a live clock.
 * Renders nothing when time tracking is off or not allowed. Starting while a
 * timer runs on another job asks before switching.
 */
export function TimerControl({ jobId, runningSession, enabled, size = "sm", compact = false, className }: TimerControlProps) {
  const run = useMutationRunner();
  const [busy, setBusy] = React.useState<"start" | "pause" | "stop" | null>(null);
  const [switchOpen, setSwitchOpen] = React.useState(false);

  if (!enabled) return null;

  const act = async (action: "start" | "pause" | "stop", switchFromRunning = false) => {
    setBusy(action);
    const result = await run(() => api.post(`/api/jobs/${jobId}/timer`, { jobId, action, switchFromRunning }), {
      success: action === "start" ? "Timer started" : action === "pause" ? "Timer paused" : "Timer stopped",
      onError: (err: ApiError) => {
        if (action === "start" && err.isConflict) {
          setSwitchOpen(true);
          return true;
        }
        return false;
      },
    });
    setBusy(null);
    return result.ok;
  };

  const switchDialog = (
    <ConfirmDialog
      open={switchOpen}
      onOpenChange={setSwitchOpen}
      title="Switch your timer to this job?"
      description="You already have a timer running on another job. Switching stops that one and starts timing this job."
      confirmLabel="Switch timer"
      onConfirm={() => act("start", true)}
    />
  );

  if (!runningSession) {
    return (
      <>
        {compact ? (
          <IconButton label="Start timer" size={size === "sm" ? "sm" : "md"} variant="outline" onClick={() => act("start")} loading={busy === "start"} className={className}>
            <Play />
          </IconButton>
        ) : (
          <Button size={size} variant="outline" leadingIcon={<Play />} onClick={() => act("start")} loading={busy === "start"} className={className}>
            Start timer
          </Button>
        )}
        {switchDialog}
      </>
    );
  }

  return (
    <div
      role="group"
      aria-label="Work timer"
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-success/30 bg-success-soft/60 pl-2.5 pr-1",
        size === "sm" ? "h-8" : "h-9",
        className,
      )}
    >
      <span aria-hidden="true" className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60 motion-reduce:animate-none" />
        <span className="relative inline-flex size-2 rounded-full bg-success" />
      </span>
      <span className="sr-only">Timer running:</span>
      <ElapsedClock startedAt={runningSession.startedAt} className="min-w-[3.25rem] px-1 text-sm text-success-fg" />
      <IconButton label="Pause timer" size="xs" variant="ghost" onClick={() => act("pause")} loading={busy === "pause"} disabled={busy !== null}>
        <Pause />
      </IconButton>
      <IconButton label="Stop timer" size="xs" variant="ghost" onClick={() => act("stop")} loading={busy === "stop"} disabled={busy !== null}>
        <Square />
      </IconButton>
      {switchDialog}
    </div>
  );
}
