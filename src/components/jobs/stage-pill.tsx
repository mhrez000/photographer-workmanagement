import type { ReactNode } from "react";
import { Zap } from "lucide-react";
import { STAGE_TONE_CLASSES } from "@/lib/constants";
import { formatDateShort } from "@/lib/dates";
import { STAGE_META, describeStage, waitingOnLabel, type Stage, type StageDisplay, type StageDisplayInput } from "@/lib/stages";
import { cn } from "@/lib/utils";

/**
 * Shared stage visuals for the simplified UI (docs/SIMPLIFICATION-PLAN.md §4).
 * Server-component safe. Every list, card and header uses these so the five
 * stages look and read the same everywhere.
 */

export interface StagePillProps {
  /** Either a precomputed display (from the queries) or the raw job columns. */
  display?: StageDisplay;
  job?: StageDisplayInput;
  /** Org timezone for "Editing since Tue". */
  timeZone?: string;
  size?: "sm" | "md";
  /** Hide the secondary text (Not started / Editing since / Round N / Not sent to client). */
  hideSubLabel?: boolean;
  className?: string;
}

export function StagePill({ display, job, timeZone, size = "sm", hideSubLabel = false, className }: StagePillProps) {
  const d = display ?? (job ? describeStage(job) : null);
  if (!d) return null;
  const tone = STAGE_TONE_CLASSES[STAGE_META[d.stage].tone];
  const sub = hideSubLabel ? null : stageSubLabelText(d, job?.startedAt ?? null, timeZone);
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full font-medium whitespace-nowrap",
        size === "sm" ? "h-6 px-2 text-xs" : "h-7 px-2.5 text-sm",
        tone.pill,
        className,
      )}
      data-stage={d.stage}
    >
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />
      <span className="truncate">{d.label}</span>
      {sub ? <span className="truncate font-normal opacity-80">· {sub}</span> : null}
    </span>
  );
}

/** The secondary text of a stage ("Not started", "Editing since 9 Oct", "Round 2", "Not sent to client"). */
export function stageSubLabelText(d: StageDisplay, startedAt: string | null, timeZone?: string): string | null {
  switch (d.subLabel) {
    case "not_started":
      return "Not started";
    case "editing":
      return startedAt ? `Editing since ${formatDateShort(startedAt, timeZone)}` : "Editing";
    case "round":
      return d.round ? `Round ${d.round}` : null;
    case "not_sent_to_client":
      return "Not sent to client";
    default:
      return null;
  }
}

/** Plain stage label with its dot, for filters and legends. */
export function StageDot({ stage, className }: { stage: Stage; className?: string }) {
  const meta = STAGE_META[stage];
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span aria-hidden="true" className={cn("size-2 rounded-full", STAGE_TONE_CLASSES[meta.tone].dot)} />
      {meta.label}
    </span>
  );
}

/** "Round 2" badge shown after a job came back with changes. */
export function RoundBadge({ round, className }: { round: number | null | undefined; className?: string }) {
  if (!round || round < 2) return null;
  return (
    <span className={cn("inline-flex h-5 items-center rounded-sm bg-stage-amber-soft px-1.5 text-2xs font-semibold text-stage-amber-fg", className)}>
      Round {round}
    </span>
  );
}

/** "Rush" badge (priority urgent). */
export function RushBadge({ rush, className }: { rush: boolean; className?: string }) {
  if (!rush) return null;
  return (
    <span className={cn("inline-flex h-5 items-center gap-1 rounded-sm bg-danger-soft px-1.5 text-2xs font-semibold text-danger-fg", className)}>
      <Zap aria-hidden="true" className="size-3" />
      Rush
    </span>
  );
}

export interface WaitingOnProps {
  job: Parameters<typeof waitingOnLabel>[0];
  viewerId?: string | null;
  prefix?: ReactNode;
  className?: string;
}

/** "Waiting on: Sam" / "Waiting on: You" — the single line that explains responsibility. */
export function WaitingOn({ job, viewerId, prefix = "Waiting on:", className }: WaitingOnProps) {
  const who = waitingOnLabel(job, viewerId);
  if (!who) return null;
  const you = who === "You";
  return (
    <span className={cn("inline-flex items-center gap-1 text-sm", you ? "font-medium text-attention-fg" : "text-ink-secondary", className)}>
      <span className="text-ink-muted">{prefix}</span>
      <span>{who}</span>
    </span>
  );
}
