import Link from "next/link";
import { Inbox } from "lucide-react";
import { RoundBadge, RushBadge, StagePill } from "@/components/jobs/stage-pill";
import { DUE_TONE_CLASS, dueText } from "@/components/my-jobs/due-text";
import { EmptyState } from "@/components/ui/empty-state";
import type { EditorOnDeskJob, EditorPickerOption } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ChangeEditorButton } from "./change-editor-button";

export interface OnDeskListProps {
  jobs: EditorOnDeskJob[];
  editorId: string;
  options: EditorPickerOption[];
  timeZone: string;
}

/** "On their desk now" (docs/SIMPLIFICATION-PLAN.md §7): stage, due date, and Change editor per job. */
export function OnDeskList({ jobs, editorId, options, timeZone }: OnDeskListProps) {
  if (jobs.length === 0) {
    return <EmptyState size="sm" icon={Inbox} title="Nothing on their desk" description="Every job they were given has been sent for checking or finished." />;
  }
  return (
    <ul className="divide-y divide-border">
      {jobs.map(({ job, canChangeEditor }) => {
        const due = dueText(job.due, timeZone);
        return (
          <li key={job.id} className="flex flex-col gap-2 px-5 py-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Link href={`/jobs/${encodeURIComponent(job.id)}`} className="min-w-0 max-w-full truncate text-sm font-medium text-ink hover:underline underline-offset-4 focus-ring rounded-xs">
                {job.name}
              </Link>
              <RoundBadge round={job.round} />
              <RushBadge rush={job.rush} />
            </div>
            <p className="flex flex-wrap items-center gap-x-2 text-sm text-ink-muted">
              <span className="truncate">{job.client.name}</span>
              <span aria-hidden="true">·</span>
              <span className={cn(DUE_TONE_CLASS[due.tone])}>{due.label}</span>
            </p>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <StagePill
                display={job.stage}
                job={{ category: job.statusCategory, revisionCount: Math.max(0, (job.round ?? 1) - 1), startedAt: job.startedAt, statusEnteredAt: job.statusEnteredAt }}
                timeZone={timeZone}
                hideSubLabel={job.stage.subLabel === "round"}
              />
              {canChangeEditor ? (
                <ChangeEditorButton jobId={job.id} version={job.version} currentEditorId={editorId} jobLabel={`${job.name} · ${job.client.name}`} options={options} timeZone={timeZone} />
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
