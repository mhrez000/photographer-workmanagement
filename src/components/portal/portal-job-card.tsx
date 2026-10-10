import Link from "next/link";
import { CalendarDays, ChevronRight, Images, PackageCheck } from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { portalDate } from "@/lib/portal";
import type { PortalJob } from "@/lib/types";
import { cn } from "@/lib/utils";
import { MilestoneStepper } from "./milestone-stepper";

/** Badge tone per client milestone (cancelled = outline). */
export function milestoneBadgeVariant(job: Pick<PortalJob, "milestone" | "cancelled" | "updating">): BadgeProps["variant"] {
  if (job.cancelled) return "outline";
  if (job.updating) return "attention";
  switch (job.milestone) {
    case "delivered":
      return "success";
    case "editing":
      return "info";
    case "shot":
      return "accent";
    default:
      return "neutral";
  }
}

export function MilestoneBadge({ job, className }: { job: Pick<PortalJob, "milestone" | "milestoneLabel" | "cancelled" | "updating">; className?: string }) {
  return (
    <Badge variant={milestoneBadgeVariant(job)} dot className={className}>
      {job.milestoneLabel}
    </Badge>
  );
}

export interface PortalJobCardProps {
  job: PortalJob;
  timeZone: string;
  /** Hide the project line (inside a project group). */
  hideProject?: boolean;
}

/** One shared job in the portal list: name, milestone, compact stepper, agreed dates. */
export function PortalJobCard({ job, timeZone, hideProject = false }: PortalJobCardProps) {
  const delivered = job.milestone === "delivered";
  return (
    <Link
      href={`/portal/jobs/${job.id}`}
      className={cn(
        "group/job block min-w-0 rounded-lg border border-border bg-surface p-4 shadow-xs transition-[border-color,box-shadow] duration-(--motion-base) ease-out-soft",
        "hover:border-border-hover hover:shadow-md focus-ring sm:p-5",
        job.cancelled && "bg-surface-sunken/70 shadow-none",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className={cn("line-clamp-2 break-words text-md font-semibold text-ink", job.cancelled && "text-ink-muted")}>{job.name}</h3>
          <p className="mt-0.5 truncate text-sm text-ink-muted">
            {job.jobTypeName}
            {!hideProject ? <> · {job.project.name}</> : null}
            <span className="numeric"> · {job.jobNumber}</span>
          </p>
        </div>
        <MilestoneBadge job={job} className="shrink-0" />
      </div>

      {!job.cancelled ? <MilestoneStepper job={job} timeZone={timeZone} compact className="mt-4" /> : null}

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-ink-secondary">
        {job.milestoneDetail ? <span className={cn(job.cancelled && "text-ink-muted")}>{job.milestoneDetail}</span> : null}
        {!job.cancelled && job.shootDate && job.milestone !== "booked" ? (
          <span className="inline-flex items-center gap-1.5">
            <CalendarDays aria-hidden="true" className="size-3.5 text-ink-subtle" />
            Shoot <span className="numeric">{portalDate(job.shootDate, timeZone)}</span>
          </span>
        ) : null}
        {!job.cancelled && !delivered && job.deliveryDueDate ? (
          <span className="inline-flex items-center gap-1.5">
            <PackageCheck aria-hidden="true" className="size-3.5 text-ink-subtle" />
            Delivery by <span className="numeric">{portalDate(job.deliveryDueDate, timeZone)}</span>
          </span>
        ) : null}
        <span className="ml-auto inline-flex items-center gap-1 font-medium text-accent-ink">
          {delivered ? (
            <>
              <Images aria-hidden="true" className="size-4" />
              View your photos
            </>
          ) : (
            "Details"
          )}
          <ChevronRight aria-hidden="true" className="size-4 transition-transform duration-(--motion-fast) group-hover/job:translate-x-0.5" />
        </span>
      </div>
    </Link>
  );
}
