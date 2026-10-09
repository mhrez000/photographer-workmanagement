import * as React from "react";
import Link from "next/link";
import { Timer } from "lucide-react";
import { ElapsedClock, TimerControl, jobHref } from "@/components/jobs";
import { formatTime } from "@/lib/dates";
import type { RunningSessionView } from "@/lib/types";

export interface RunningTimerBannerProps {
  session: RunningSessionView;
  timeZone: string;
  timeTrackingEnabled: boolean;
}

/** Shown above the queue while the viewer's work timer runs (pause / stop inline). */
export function RunningTimerBanner({ session, timeZone, timeTrackingEnabled }: RunningTimerBannerProps) {
  return (
    <section
      aria-label="Running timer"
      className="flex flex-col gap-3 rounded-lg border border-success/30 bg-success-soft/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-success/15 text-success-fg">
          <Timer aria-hidden="true" className="size-4.5" />
          <span aria-hidden="true" className="absolute right-0.5 top-0.5 flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex size-2 rounded-full bg-success" />
          </span>
        </span>
        <div className="min-w-0">
          <p className="text-xs text-success-fg">
            Timer running · {session.statusName} · since <span className="numeric">{formatTime(session.startedAt, timeZone)}</span>
          </p>
          <p className="flex min-w-0 items-baseline gap-2">
            <Link href={jobHref(session.job.id, "time")} className="truncate font-semibold text-ink underline-offset-2 hover:underline focus-ring rounded-xs">
              <span className="mr-1.5 font-mono text-xs font-normal text-ink-muted numeric">{session.job.jobNumber}</span>
              {session.job.name}
            </Link>
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 sm:shrink-0">
        {timeTrackingEnabled ? (
          <TimerControl jobId={session.job.id} runningSession={{ id: session.id, startedAt: session.startedAt }} enabled size="md" />
        ) : (
          <ElapsedClock startedAt={session.startedAt} className="text-md text-success-fg" />
        )}
      </div>
    </section>
  );
}
