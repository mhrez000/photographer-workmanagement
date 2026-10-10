import { Check } from "lucide-react";
import { milestoneSteps, portalDay } from "@/lib/portal";
import type { PortalJob } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface MilestoneStepperProps {
  job: Pick<PortalJob, "milestone" | "updating" | "shootDate" | "deliveredAt" | "deliveryDueDate" | "cancelled">;
  timeZone: string;
  /** Compact = list cards (no dates, smaller dots). */
  compact?: boolean;
  className?: string;
}

/**
 * Booked → Shot → Editing → Delivered (docs/ROLES.md §7.4, §7.7). An ordered
 * list so screen readers hear "step 2 of 4, current". Cancelled jobs render
 * nothing (the card shows the Cancelled state instead).
 */
export function MilestoneStepper({ job, timeZone, compact = false, className }: MilestoneStepperProps) {
  const steps = milestoneSteps(job);
  if (steps.length === 0) return null;
  return (
    <ol aria-label="Progress" className={cn("grid grid-cols-4", className)}>
      {steps.map((step, index) => {
        const done = step.state === "done";
        const current = step.state === "current";
        const date = !compact && step.date && (step.key !== "booked" || job.milestone === "booked") ? portalDay(step.date, timeZone) : null;
        return (
          <li
            key={step.key}
            aria-current={current ? "step" : undefined}
            className="relative flex min-w-0 flex-col items-center text-center"
          >
            {/* connector to the previous step */}
            {index > 0 ? (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute right-1/2 h-0.5 w-full",
                  compact ? "top-[7px]" : "top-[11px]",
                  done || current ? "bg-accent" : "bg-border-strong",
                )}
              />
            ) : null}
            <span
              aria-hidden="true"
              className={cn(
                "relative z-[1] flex items-center justify-center rounded-full border-2 transition-colors",
                compact ? "size-4" : "size-6",
                done && "border-accent bg-accent text-accent-fg",
                current && "border-accent bg-surface",
                !done && !current && "border-border-strong bg-surface",
              )}
            >
              {done ? <Check className={compact ? "size-2.5" : "size-3.5"} strokeWidth={3} /> : null}
              {current ? <span className={cn("rounded-full bg-accent", compact ? "size-1.5" : "size-2.5", job.updating && "animate-pulse")} /> : null}
            </span>
            <span
              className={cn(
                "mt-1.5 max-w-full truncate px-0.5",
                compact ? "text-2xs" : "text-xs sm:text-sm",
                current ? "font-semibold text-ink" : done ? "text-ink-secondary" : "text-ink-subtle",
              )}
            >
              {step.label}
              <span className="sr-only">{done ? " (done)" : current ? " (current)" : " (upcoming)"}</span>
            </span>
            {date ? <span className="numeric mt-0.5 text-2xs text-ink-muted sm:text-xs">{date}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
