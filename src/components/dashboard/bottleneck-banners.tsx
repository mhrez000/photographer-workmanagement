import * as React from "react";
import Link from "next/link";
import { ArrowRight, ChevronDown, OctagonAlert, TriangleAlert } from "lucide-react";
import type { BottleneckAlert } from "@/lib/types";
import { cn, pluralise } from "@/lib/utils";

export interface BottleneckBannersProps {
  alerts: BottleneckAlert[];
  /** Banners shown before the rest collapse behind "Show N more". */
  visible?: number;
  /** Link to the full bottleneck page (analytics viewers only). */
  allHref?: string | null;
  className?: string;
}

function linkLabel(alert: BottleneckAlert): string {
  const n = alert.jobs.length || alert.count;
  if (alert.kind === "editor_overloaded" && alert.user) return `View ${alert.user.name.split(" ")[0]}'s ${pluralise(n, "job")}`;
  return `View ${pluralise(n, "job")}`;
}

function Banner({ alert }: { alert: BottleneckAlert }) {
  const critical = alert.severity === "critical";
  const Icon = critical ? OctagonAlert : TriangleAlert;
  return (
    <li
      className={cn(
        "flex flex-col gap-2 border-b border-border px-4 py-2.5 last:border-0 sm:flex-row sm:items-center sm:gap-4",
        critical ? "bg-danger-soft/40" : "bg-attention-soft/40",
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
        <span
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full sm:mt-0",
            critical ? "bg-danger-soft text-danger" : "bg-attention-soft text-attention",
          )}
        >
          <Icon aria-hidden="true" className="size-3.5" />
          <span className="sr-only">{critical ? "Critical" : "Warning"}:</span>
        </span>
        <p className={cn("min-w-0 text-sm font-medium", critical ? "text-danger-fg" : "text-attention-fg")}>{alert.message}</p>
      </div>
      <Link
        href={alert.href}
        className={cn(
          "group/bn ml-9 inline-flex shrink-0 items-center gap-1 self-start rounded-sm text-sm font-medium text-ink-secondary hover:text-ink focus-ring sm:ml-0 sm:self-auto",
        )}
      >
        {linkLabel(alert)}
        <ArrowRight aria-hidden="true" className="size-3.5 transition-transform duration-(--motion-fast) group-hover/bn:translate-x-0.5" />
      </Link>
    </li>
  );
}

/**
 * Bottleneck alerts (spec §14): critical = danger tint, warning = amber.
 * Renders nothing when there are none. The first few are always visible;
 * the rest sit behind a native disclosure (no JS needed).
 */
export function BottleneckBanners({ alerts, visible = 3, allHref, className }: BottleneckBannersProps) {
  if (alerts.length === 0) return null;
  const sorted = [...alerts].sort((a, b) => (a.severity === b.severity ? b.count - a.count : a.severity === "critical" ? -1 : 1));
  const head = sorted.slice(0, visible);
  const rest = sorted.slice(visible);
  const critical = alerts.filter((a) => a.severity === "critical").length;

  return (
    <section aria-labelledby="bottlenecks-title" className={cn("min-w-0", className)}>
      <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <h2 id="bottlenecks-title" className="flex items-center gap-2 text-sm font-semibold text-ink">
            Needs attention
            <span className="numeric rounded-full bg-surface-muted px-1.5 text-2xs font-medium text-ink-muted">{alerts.length}</span>
            {critical > 0 ? <span className="text-xs font-normal text-danger-fg">{critical} critical</span> : null}
          </h2>
          {allHref ? (
            <Link href={allHref} className="rounded-sm text-xs font-medium text-ink-muted hover:text-ink focus-ring">
              All bottlenecks
            </Link>
          ) : null}
        </div>
        <ul>
          {head.map((a) => (
            <Banner key={`${a.kind}-${a.user?.id ?? ""}`} alert={a} />
          ))}
        </ul>
        {rest.length > 0 ? (
          <details className="group/more border-t border-border">
            <summary className="flex cursor-pointer list-none items-center justify-center gap-1 px-4 py-2 text-xs font-medium text-ink-muted hover:text-ink focus-ring-inset [&::-webkit-details-marker]:hidden">
              <span className="group-open/more:hidden">Show {rest.length} more</span>
              <span className="hidden group-open/more:inline">Show fewer</span>
              <ChevronDown aria-hidden="true" className="size-3.5 transition-transform group-open/more:rotate-180" />
            </summary>
            <ul className="border-t border-border">
              {rest.map((a) => (
                <Banner key={`${a.kind}-${a.user?.id ?? ""}`} alert={a} />
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </section>
  );
}
