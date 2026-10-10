import * as React from "react";
import Link from "next/link";
import { ArrowRight, Coffee } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { WorkloadBand } from "@/components/jobs/workload-band";
import { EmptyState } from "@/components/ui/empty-state";
import { Progress } from "@/components/ui/progress";
import type { JobRow, KpiSummary, WorkloadRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DashboardJobRows } from "./job-list-widget";

const BAND_TONE = { healthy: "success", near_capacity: "warning", overloaded: "danger" } as const;

function Stat({ label, value, tone }: { label: string; value: number; tone?: "danger" | "attention" }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-2xs text-ink-muted">{label}</dt>
      <dd
        className={cn(
          "numeric text-lg font-semibold leading-6 text-ink",
          value > 0 && tone === "danger" && "text-danger-fg",
          value > 0 && tone === "attention" && "text-attention-fg",
          value === 0 && "text-ink-subtle",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

export interface MyWorkloadWidgetProps {
  /** Editors: their WorkloadRow. Photographers: null (counts come from `kpis`). */
  workload: WorkloadRow | null;
  kpis: KpiSummary;
  queue: JobRow[];
  timeZone: string;
  role: "editor" | "photographer" | "client";
}

/** The viewer's own load (band + capacity for editors) and a preview of the next jobs in their queue. */
export function MyWorkloadWidget({ workload, kpis, queue, timeZone, role }: MyWorkloadWidgetProps) {
  const pct = workload ? Math.round(workload.ratio * 100) : null;
  return (
    <SectionCard
      title={role === "editor" ? "My workload" : "My queue"}
      actions={workload ? <WorkloadBand band={workload.band} ratio={workload.ratio} reason={workload.bandReason} showRatio /> : null}
      flush
      footer={
        <Link href="/workspace/my" className="inline-flex items-center gap-1 rounded-sm font-medium text-accent-ink hover:underline focus-ring">
          Open My Work
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      }
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        {workload ? (
          <>
            <dl className="grid grid-cols-4 gap-3">
              <Stat label="Active" value={workload.active} />
              <Stat label="In progress" value={workload.inProgress + workload.revision} />
              <Stat label="Due today" value={workload.dueToday} tone="attention" />
              <Stat label="Overdue" value={workload.overdue} tone="danger" />
            </dl>
            <div>
              <div className="mb-1 flex items-center justify-between text-xs text-ink-muted">
                <span>Capacity used</span>
                <span className="numeric">
                  {pct}% of {workload.editor.capacityHoursPerWeek}h / week
                </span>
              </div>
              <Progress value={Math.min(pct ?? 0, 100)} tone={BAND_TONE[workload.band]} size="sm" label="Capacity used" />
            </div>
          </>
        ) : (
          <dl className="grid grid-cols-4 gap-3">
            <Stat label="Active" value={kpis.active} />
            <Stat label="To review" value={kpis.awaitingReview} tone="attention" />
            <Stat label="Due today" value={kpis.dueToday} tone="attention" />
            <Stat label="Overdue" value={kpis.overdue} tone="danger" />
          </dl>
        )}
      </div>
      <div className="border-t border-border">
        <p className="eyebrow px-5 pt-3 pb-1">{role === "editor" ? "My queue" : "Up next"}</p>
        {role === "editor" && queue.length > 0 ? <QueueBuckets queue={queue} /> : null}
        {queue.length === 0 ? (
          <EmptyState
            size="sm"
            icon={Coffee}
            title="Your queue is clear"
            description={role === "editor" ? "New assignments will show up here." : "Jobs waiting on you will show up here."}
          />
        ) : (
          <DashboardJobRows jobs={queue} timeZone={timeZone} person={role === "editor" ? "photographer" : "editor"} max={5} />
        )}
      </div>
    </SectionCard>
  );
}

/** Editor queue at a glance (docs/ROLES.md §9): To accept · In progress · Revisions to address · Paused. */
function QueueBuckets({ queue }: { queue: MyWorkloadWidgetProps["queue"] }) {
  const buckets = [
    { label: "To accept", n: queue.filter((j) => j.statusCategory === "assigned" && !j.isPaused).length },
    { label: "In progress", n: queue.filter((j) => (j.statusCategory === "accepted" || j.statusCategory === "in_progress") && !j.isPaused).length },
    { label: "Revisions to address", n: queue.filter((j) => j.statusCategory === "revision" && !j.isPaused).length },
    { label: "Paused", n: queue.filter((j) => j.isPaused).length },
  ];
  return (
    <ul aria-label="Queue by stage" className="flex flex-wrap gap-1.5 px-5 pb-2">
      {buckets.map((b) => (
        <li key={b.label} className="inline-flex h-6 items-center gap-1 rounded-full bg-surface-muted px-2 text-xs text-ink-secondary">
          {b.label} <span className="numeric font-medium text-ink">{b.n}</span>
        </li>
      ))}
    </ul>
  );
}
