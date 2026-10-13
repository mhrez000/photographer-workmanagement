import Link from "next/link";
import { ArrowRight, CalendarDays, Camera, Flag } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { civilLong, relativeCivil } from "@/components/jobs-list/format";
import { EmptyState } from "@/components/ui/empty-state";
import type { ComingUpItem } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface ComingUpSectionProps {
  items: ComingUpItem[];
  today: string;
}

/** "Coming up this week" — shoots and due dates for the next 7 days, grouped by day (docs/SIMPLIFICATION-PLAN.md §6). */
export function ComingUpSection({ items, today }: ComingUpSectionProps) {
  const days = new Map<string, ComingUpItem[]>();
  for (const item of items) days.set(item.civilDate, [...(days.get(item.civilDate) ?? []), item]);
  return (
    <SectionCard
      id="coming-up"
      title="Coming up this week"
      flush
      footer={
        <Link href="/jobs?view=calendar" className="inline-flex items-center gap-1 font-medium text-ink-secondary hover:text-ink focus-ring rounded-xs">
          Open the calendar
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      }
    >
      {items.length === 0 ? (
        <EmptyState size="sm" icon={CalendarDays} title="A quiet week" description="No shoots or due dates in the next 7 days." />
      ) : (
        <ol className="divide-y divide-border">
          {[...days.entries()].map(([day, list]) => {
            const heading = relativeCivil(day, today);
            return (
              <li key={day} className="flex flex-col gap-1.5 px-5 py-3">
                <h3 className={cn("text-xs font-semibold uppercase tracking-wide", day === today ? "text-accent-ink" : "text-ink-muted")} title={civilLong(day)}>
                  {heading === "Today" || heading === "Tomorrow" ? heading : civilLong(day)}
                </h3>
                <ul className="flex flex-col gap-1">
                  {list.map((item) => {
                    const Icon = item.kind === "shoot" ? Camera : Flag;
                    const late = item.kind === "due" && item.job.due.late;
                    return (
                      <li key={`${item.job.id}:${item.kind}`} className="flex items-center gap-2 text-sm">
                        <span className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 text-2xs font-semibold", item.kind === "shoot" ? "bg-surface-muted text-ink-secondary" : late ? "bg-danger-soft text-danger-fg" : "bg-stage-blue-soft text-stage-blue-fg")}>
                          <Icon aria-hidden="true" className="size-3" />
                          {item.kind === "shoot" ? "Shoot" : "Due"}
                        </span>
                        <Link href={`/jobs/${item.job.id}`} className="truncate font-medium text-ink underline-offset-2 hover:underline focus-ring rounded-xs">
                          {item.job.name}
                        </Link>
                        <span className="truncate text-ink-muted">{item.job.client.name}</span>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ol>
      )}
    </SectionCard>
  );
}
