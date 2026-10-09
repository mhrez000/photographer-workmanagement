"use client";

import * as React from "react";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api-client";
import { addCivilDays, civilDate, formatDate, formatWeekday, todayCivil } from "@/lib/dates";
import type { ActivityFeedItem, Paginated } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ActivityItem } from "./activity-item";

export interface ActivityFeedProps {
  initialItems: ActivityFeedItem[];
  initialCursor: string | null;
  /** Filters re-sent with every "Load more" request to /api/activity. */
  query?: Record<string, string | readonly string[] | undefined>;
  timeZone: string;
  /** user id → name, for assignee before/after values. */
  people: Readonly<Record<string, string>>;
  /** Rendered when there are no events at all. */
  empty?: React.ReactNode;
  /** Smaller day headers for embedded feeds (client / project pages). */
  compact?: boolean;
  className?: string;
}

interface DayGroup {
  day: string;
  items: ActivityFeedItem[];
}

function groupByDay(items: readonly ActivityFeedItem[], timeZone: string): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const item of items) {
    const day = civilDate(item.createdAt, timeZone) ?? "";
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

function dayLabel(day: string, timeZone: string): string {
  const today = todayCivil(timeZone);
  if (day === today) return "Today";
  if (day === addCivilDays(today, -1)) return "Yesterday";
  // Noon UTC keeps the weekday stable in every timezone.
  return `${formatWeekday(`${day}T12:00:00Z`, "UTC")} ${formatDate(day, timeZone)}`;
}

/** The activity feed: grouped by day (org timezone), cursor "Load more". */
export function ActivityFeed({ initialItems, initialCursor, query, timeZone, people, empty, compact = false, className }: ActivityFeedProps) {
  const [items, setItems] = React.useState(initialItems);
  const [cursor, setCursor] = React.useState(initialCursor);
  const [loading, setLoading] = React.useState(false);

  const loadMore = async () => {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const page = await api.get<Paginated<ActivityFeedItem>>("/api/activity", { query: { ...query, cursor } });
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...page.items.filter((i) => !seen.has(i.id))];
      });
      setCursor(page.nextCursor);
    } catch (err) {
      toast.error("Couldn't load older activity", errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  if (items.length === 0) {
    return (
      <>
        {empty ?? (
          <EmptyState
            icon={History}
            size="sm"
            title="No activity yet"
            description="Changes to jobs, assignments, deadlines and comments will appear here as they happen."
          />
        )}
      </>
    );
  }

  const groups = groupByDay(items, timeZone);

  return (
    <div className={cn("flex flex-col", className)}>
      {groups.map((g) => (
        <section key={g.day} aria-label={dayLabel(g.day, timeZone)} className="relative">
          <h3
            className={cn(
              "sticky top-0 z-[1] -mx-1 bg-surface/90 px-1 backdrop-blur-sm",
              compact ? "py-1.5 eyebrow" : "py-2 text-xs font-semibold text-ink-secondary",
            )}
          >
            {dayLabel(g.day, timeZone)}
            <span className="ml-2 font-normal text-ink-subtle numeric">{g.items.length}</span>
          </h3>
          <ol className="divide-y divide-border/70">
            {g.items.map((item) => (
              <ActivityItem key={item.id} item={item} timeZone={timeZone} people={people} />
            ))}
          </ol>
        </section>
      ))}
      <div className="flex items-center justify-center border-t border-border pt-4">
        {cursor ? (
          <Button variant="outline" size="sm" onClick={loadMore} loading={loading}>
            Load more
          </Button>
        ) : (
          <p className="text-xs text-ink-subtle">You’ve reached the beginning of this history.</p>
        )}
      </div>
    </div>
  );
}
