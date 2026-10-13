import Link from "next/link";
import { CircleCheckBig } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDateShort } from "@/lib/dates";
import type { RecentlyFinishedJob } from "@/lib/types";
import { cn, pluralise } from "@/lib/utils";

export interface RecentlyFinishedProps {
  jobs: RecentlyFinishedJob[];
  timeZone: string;
}

/** "On time" / "2 days late" / "No due date" for a finished job, judged on the editor's first send. */
function timing(job: RecentlyFinishedJob): { label: string; className: string } {
  if (job.onTime === true) return { label: "On time", className: "text-success-fg" };
  if (job.onTime === false) return { label: job.daysLate && job.daysLate > 0 ? `${pluralise(job.daysLate, "day")} late` : "Late", className: "text-danger-fg" };
  return { label: "No due date", className: "text-ink-subtle" };
}

/** "Recently finished" (docs/SIMPLIFICATION-PLAN.md §7): the last 20 approvals, each marked On time / N days late, with the rounds of changes. */
export function RecentlyFinished({ jobs, timeZone }: RecentlyFinishedProps) {
  if (jobs.length === 0) {
    return <EmptyState size="sm" icon={CircleCheckBig} title="Nothing finished yet" description="Jobs you approve will be listed here with whether they were sent on time." />;
  }
  return (
    <ul className="divide-y divide-border">
      {jobs.map((item) => {
        const t = timing(item);
        return (
          <li key={item.job.id} className="flex flex-col gap-1 px-5 py-3">
            <Link href={`/jobs/${encodeURIComponent(item.job.id)}`} className="min-w-0 max-w-full self-start truncate text-sm font-medium text-ink hover:underline underline-offset-4 focus-ring rounded-xs">
              {item.job.name}
            </Link>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-ink-muted">
              <span className="truncate">{item.job.client.name}</span>
              <span aria-hidden="true">·</span>
              <span>Done {formatDateShort(item.approvedAt, timeZone)}</span>
              <span aria-hidden="true">·</span>
              <span className={cn("font-medium", t.className)}>{t.label}</span>
              <span aria-hidden="true">·</span>
              <span>{item.rounds === 0 ? "No changes asked" : `${pluralise(item.rounds, "round")} of changes`}</span>
            </p>
          </li>
        );
      })}
    </ul>
  );
}
