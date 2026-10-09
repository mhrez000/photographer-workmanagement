import * as React from "react";
import Link from "next/link";
import { Activity, ArrowRight, Bot } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { jobHref } from "@/components/jobs/job-link";
import { RelativeTime } from "@/components/jobs/relative-time";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import type { ActivityFeedItem } from "@/lib/types";

/** Event types worth surfacing on the dashboard feed (milestones, not every status echo). */
export const DASHBOARD_ACTIVITY_EVENT_TYPES = [
  "job.created",
  "job.accepted",
  "job.declined",
  "job.work_started",
  "job.paused",
  "job.submitted",
  "job.review_started",
  "job.approved",
  "job.delivered",
  "job.completed",
  "job.cancelled",
  "job.reopened",
  "job.restored",
  "job.became_overdue",
  "job.due_date_changed",
  "job.priority_changed",
  "assignment.created",
  "revision.requested",
  "revision.resolved",
  "comment.added",
  "link.added",
  "link.replaced",
] as const;

function sentenceOf(item: ActivityFeedItem): string {
  if (item.sentence) return item.sentence;
  const who = item.actor?.name ?? (item.isSystem ? "System" : "Someone");
  return `${who} ${item.summary}`;
}

export interface ActivityWidgetProps {
  items: ActivityFeedItem[];
  timeZone: string;
  max?: number;
}

/** Recent activity: actor avatar, the feed sentence, relative time; rows open the job. */
export function ActivityWidget({ items, timeZone, max = 8 }: ActivityWidgetProps) {
  const shown = items.slice(0, max);
  return (
    <SectionCard
      title="Recent activity"
      flush
      footer={
        <Link href="/activity" className="inline-flex items-center gap-1 rounded-sm font-medium text-accent-ink hover:underline focus-ring">
          Open activity log
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      }
    >
      {shown.length === 0 ? (
        <EmptyState
          size="sm"
          icon={Activity}
          title="No activity yet"
          description="Assignments, submissions, approvals and revisions will appear here as work moves."
        />
      ) : (
        <ol className="divide-y divide-border">
          {shown.map((item) => {
            const sentence = sentenceOf(item);
            const href = item.job ? jobHref(item.job.id, "activity") : null;
            return (
              <li key={item.id} className="relative flex items-start gap-3 px-5 py-2.5 transition-colors duration-(--motion-fast) hover:bg-surface-muted/50">
                {item.actor ? (
                  <Avatar name={item.actor.name} colour={item.actor.avatarColour || undefined} size="sm" className="mt-0.5" />
                ) : (
                  <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-muted text-ink-muted">
                    <Bot aria-hidden="true" className="size-3.5" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  {href ? (
                    <Link href={href} className="line-clamp-2 rounded-xs text-sm text-ink-secondary hover:text-ink focus-ring after:absolute after:inset-0">
                      {sentence}
                    </Link>
                  ) : (
                    <p className="line-clamp-2 text-sm text-ink-secondary">{sentence}</p>
                  )}
                  <RelativeTime value={item.createdAt} timeZone={timeZone} className="text-xs text-ink-subtle" />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </SectionCard>
  );
}
