"use client";

import * as React from "react";
import { Activity, ArrowRight, Bot, ChevronRight, ShieldCheck } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { useUrlState } from "@/hooks";
import { api, errorMessage } from "@/lib/api-client";
import { formatDate, formatDateTime, formatRelative } from "@/lib/dates";
import type { ActivityFeedItem, Paginated } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/toast";
import { ACTIVITY_GROUP_KEYS, ACTIVITY_GROUPS, activityGroupOf, clip, valueChanges, type ActivityGroup } from "./format";

export interface ActivityTabProps {
  jobId: string;
  initial: Paginated<ActivityFeedItem>;
  /** Active filter groups (from `?events=`). Empty = everything. */
  groups: ActivityGroup[];
  timeZone: string;
}

function ActivityRow({ item, timeZone }: { item: ActivityFeedItem; timeZone: string }) {
  const changes = valueChanges(item.previousValue, item.newValue, (iso) => formatDateTime(iso, timeZone));
  // Created / requested events have no "before": show the recorded values plainly.
  const onlyNew = item.previousValue === null || item.previousValue === undefined;
  const group = activityGroupOf(item.eventType);
  const actor = item.actor?.name ?? (item.isSystem ? (item.metadata?.cause === "automation" ? "Automation" : "System") : "Someone");

  return (
    <li className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 px-4 py-3 sm:px-5">
      {item.actor ? (
        <Avatar name={item.actor.name} colour={item.actor.avatarColour || undefined} size="md" className={cn(!item.actor.isActive && "grayscale opacity-60")} />
      ) : (
        <span className="flex size-8 items-center justify-center rounded-full bg-surface-muted text-ink-muted ring-1 ring-inset ring-border">
          <Bot aria-hidden="true" className="size-4" />
        </span>
      )}
      <div className="min-w-0">
        <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <p className="min-w-0 text-sm text-ink-secondary">
            <strong className="font-semibold text-ink">{actor}</strong> {item.summary}
          </p>
          <time dateTime={item.createdAt} className="shrink-0 text-xs text-ink-muted numeric" title={formatRelative(item.createdAt)} suppressHydrationWarning>
            {formatDateTime(item.createdAt, timeZone)}
          </time>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <code className="rounded-xs bg-surface-muted px-1.5 py-0.5 font-mono text-2xs text-ink-muted">{item.eventType}</code>
          {group ? <span className="text-2xs text-ink-subtle">{ACTIVITY_GROUPS[group].label}</span> : null}
          {item.visibility === "management" ? (
            <span className="inline-flex items-center gap-1 text-2xs font-medium text-warning-fg">
              <ShieldCheck aria-hidden="true" className="size-3" /> Management only
            </span>
          ) : null}
        </div>
        {changes.length > 0 ? (
          <details className="group mt-2">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-xs text-xs font-medium text-ink-muted hover:text-ink focus-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-90" />
              {onlyNew ? `Recorded values (${changes.length})` : changes.length === 1 ? `${changes[0].label} changed` : `${changes.length} changes`}
            </summary>
            <dl className="mt-2 overflow-hidden rounded-md border border-border text-xs">
              {changes.map((c) => (
                <div key={c.key} className="grid gap-1 border-b border-border px-3 py-2 last:border-0 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-3">
                  <dt className="font-medium text-ink-muted">{c.label}</dt>
                  {onlyNew ? (
                    <dd className="min-w-0 break-words text-ink">{c.after === null || c.after === "" ? <span className="italic text-ink-subtle">empty</span> : clip(c.after, 240)}</dd>
                  ) : (
                    <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className={cn("rounded-xs px-1.5 py-0.5 break-words", c.before === null ? "text-ink-subtle italic" : "bg-danger-soft/70 text-ink-secondary line-through decoration-danger/40")}>
                        {c.before === null ? "empty" : clip(c.before, 240)}
                      </span>
                      <ArrowRight aria-hidden="true" className="size-3 shrink-0 text-ink-subtle" />
                      <span className={cn("rounded-xs px-1.5 py-0.5 break-words", c.after === null ? "text-ink-subtle italic" : "bg-success-soft/80 text-ink")}>
                        {c.after === null ? "empty" : clip(c.after, 240)}
                      </span>
                    </dd>
                  )}
                </div>
              ))}
            </dl>
          </details>
        ) : null}
      </div>
    </li>
  );
}

/** Every audit event of the job, newest first, with before → after values (spec §6, §37). */
export function ActivityTab({ jobId, initial, groups, timeZone }: ActivityTabProps) {
  const url = useUrlState();
  const [pages, setPages] = React.useState<{ key: string; items: ActivityFeedItem[]; cursor: string | null }>({ key: "", items: [], cursor: null });
  const [loading, setLoading] = React.useState(false);
  const key = `${initial.items[0]?.id ?? ""}|${groups.join(",")}`;
  const extra = pages.key === key ? pages.items : [];
  const cursor = pages.key === key ? pages.cursor : initial.nextCursor;
  const items = [...initial.items, ...extra];

  const toggle = (g: ActivityGroup) => {
    const next = groups.includes(g) ? groups.filter((x) => x !== g) : [...groups, g];
    url.set("events", next.length > 0 ? next.join(",") : null);
  };

  const loadMore = async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const eventType = groups.flatMap((g) => [...ACTIVITY_GROUPS[g].types]);
      const page = await api.get<Paginated<ActivityFeedItem>>(`/api/jobs/${jobId}/activity`, { query: { cursor, limit: 50, eventType } });
      setPages({ key, items: [...extra, ...page.items], cursor: page.nextCursor });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // Day groups for scanability.
  const days: { civil: string; items: ActivityFeedItem[] }[] = [];
  for (const item of items) {
    const label = formatDate(item.createdAt, timeZone);
    const last = days[days.length - 1];
    if (last && last.civil === label) last.items.push(item);
    else days.push({ civil: label, items: [item] });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter events">
        <button
          type="button"
          onClick={() => url.set("events", null)}
          aria-pressed={groups.length === 0}
          className={cn(
            "inline-flex h-8 items-center rounded-full border px-3 text-sm transition-colors focus-ring",
            groups.length === 0 ? "border-ink bg-ink text-ink-inverse" : "border-border bg-surface text-ink-secondary hover:border-border-hover",
          )}
        >
          All events
        </button>
        {ACTIVITY_GROUP_KEYS.map((g) => {
          const on = groups.includes(g);
          return (
            <button
              key={g}
              type="button"
              onClick={() => toggle(g)}
              aria-pressed={on}
              className={cn(
                "inline-flex h-8 items-center rounded-full border px-3 text-sm transition-colors focus-ring",
                on ? "border-accent bg-accent-soft text-accent-ink" : "border-border bg-surface text-ink-secondary hover:border-border-hover",
              )}
            >
              {ACTIVITY_GROUPS[g].label}
            </button>
          );
        })}
        {url.isPending ? <span className="ml-1 text-xs text-ink-muted">Filtering…</span> : null}
      </div>

      {items.length === 0 ? (
        <Card>
          <EmptyState
            icon={Activity}
            title={groups.length > 0 ? "No matching events" : "No activity yet"}
            description={groups.length > 0 ? "Nothing of this kind has happened on this job. Try another filter." : "Every change to this job is recorded here with who, what, when, and before → after values."}
            action={groups.length > 0 ? <Button variant="outline" size="sm" onClick={() => url.set("events", null)}>Show all events</Button> : null}
          />
        </Card>
      ) : (
        <Card flush className={cn("overflow-hidden transition-opacity", url.isPending && "opacity-60")}>
          {days.map((day) => (
            <section key={day.civil} aria-label={day.civil}>
              <h3 className="border-b border-border bg-surface-sunken px-4 py-1.5 eyebrow sm:px-5">{day.civil}</h3>
              <ol className="divide-y divide-border">
                {day.items.map((item) => (
                  <ActivityRow key={item.id} item={item} timeZone={timeZone} />
                ))}
              </ol>
            </section>
          ))}
        </Card>
      )}

      {cursor ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void loadMore()} loading={loading}>
            Load older events
          </Button>
        </div>
      ) : items.length > 0 ? (
        <p className="text-center text-xs text-ink-subtle">Beginning of this job&apos;s record · {items.length} events</p>
      ) : null}
    </div>
  );
}
