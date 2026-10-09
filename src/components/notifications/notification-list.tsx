"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, CheckCheck } from "lucide-react";
import { RelativeTime } from "@/components/jobs/relative-time";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { toast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/api-client";
import { NOTIFICATION_TYPE_META } from "@/lib/constants";
import { addCivilDays, civilDate, todayCivil } from "@/lib/dates";
import type { NotificationView, Paginated } from "@/lib/types";
import { cn } from "@/lib/utils";
import { NOTIFICATION_ICON, NOTIFICATION_TONE_CLASS } from "./notification-meta";

interface DayGroup {
  key: string;
  label: string;
  items: NotificationView[];
}

function dayLabel(civil: string, today: string): string {
  if (civil === today) return "Today";
  if (civil === addCivilDays(today, -1)) return "Yesterday";
  const [y, m, d] = civil.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const sameYear = civil.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  }).format(date);
}

/** Groups notifications (already newest first) by civil day in the org timezone. */
export function groupByDay(items: NotificationView[], timeZone: string, now: Date = new Date()): DayGroup[] {
  const today = todayCivil(timeZone, now);
  const groups: DayGroup[] = [];
  for (const n of items) {
    const key = civilDate(n.createdAt, timeZone) ?? "unknown";
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, label: key === "unknown" ? "Earlier" : dayLabel(key, today), items: [] };
      groups.push(group);
    }
    group.items.push(n);
  }
  return groups;
}

export interface NotificationListProps {
  initialItems: NotificationView[];
  initialCursor: string | null;
  filter: "unread" | "all";
  timeZone: string;
}

/**
 * The notification centre list: grouped by day, icon per type, unread dot.
 * Clicking a notification marks it read (POST /api/notifications/:id/read)
 * and opens its link; "Load more" pages with the keyset cursor.
 */
export function NotificationList({ initialItems, initialCursor, filter, timeZone }: NotificationListProps) {
  const router = useRouter();
  const [items, setItems] = React.useState(initialItems);
  const [cursor, setCursor] = React.useState(initialCursor);
  const [loadingMore, setLoadingMore] = React.useState(false);

  const markLocal = (id: string) =>
    setItems((prev) => prev.map((n) => (n.id === id && !n.readAt ? { ...n, readAt: new Date().toISOString() } : n)));

  const markRead = async (n: NotificationView): Promise<boolean> => {
    if (n.readAt) return true;
    markLocal(n.id);
    try {
      await api.post(`/api/notifications/${n.id}/read`);
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: null } : x)));
      return false;
    }
  };

  const open = async (event: React.MouseEvent<HTMLAnchorElement>, n: NotificationView) => {
    // Let the browser handle new-tab / new-window clicks; still record the read.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) {
      void markRead(n).then(() => router.refresh());
      return;
    }
    event.preventDefault();
    await markRead(n);
    router.push(n.linkPath);
    router.refresh();
  };

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await api.get<Paginated<NotificationView>>("/api/notifications", {
        query: { cursor, limit: 30, unread: filter === "unread" ? 1 : undefined },
      });
      setItems((prev) => {
        const seen = new Set(prev.map((n) => n.id));
        return [...prev, ...page.items.filter((n) => !seen.has(n.id))];
      });
      setCursor(page.nextCursor);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const groups = groupByDay(items, timeZone);

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`day-${group.key}`}>
          <h2 id={`day-${group.key}`} className="eyebrow mb-2 px-1">
            {group.label}
          </h2>
          <ol className="overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
            {group.items.map((n) => {
              const meta = NOTIFICATION_ICON[n.type] ?? NOTIFICATION_ICON.automation;
              const Icon = meta.icon;
              const unread = !n.readAt;
              return (
                <li
                  key={n.id}
                  className={cn(
                    "group/notif relative flex items-start gap-3 border-b border-border px-4 py-3 last:border-0 transition-colors duration-(--motion-fast) hover:bg-surface-muted/50 sm:px-5",
                    unread && "bg-accent-soft/25",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn("absolute left-1.5 top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-accent transition-opacity sm:left-2", unread ? "opacity-100" : "opacity-0")}
                  />
                  <span className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full", NOTIFICATION_TONE_CLASS[meta.tone])}>
                    <Icon aria-hidden="true" className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <a
                      href={n.linkPath}
                      onClick={(e) => void open(e, n)}
                      className="block rounded-xs focus-ring after:absolute after:inset-0"
                    >
                      <span className="sr-only">{unread ? "Unread: " : ""}</span>
                      <span className={cn("block text-sm", unread ? "font-semibold text-ink" : "font-medium text-ink-secondary")}>{n.title}</span>
                    </a>
                    {n.body ? <p className="mt-0.5 line-clamp-2 text-sm text-ink-muted">{n.body}</p> : null}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
                      {[
                        n.actor ? (
                          <span key="actor" className="inline-flex items-center gap-1.5">
                            <Avatar name={n.actor.name} colour={n.actor.avatarColour || undefined} size="xs" />
                            {n.actor.name}
                          </span>
                        ) : null,
                        n.job ? (
                          <span key="job" className="max-w-[16rem] truncate">
                            <span className="font-mono numeric">{n.job.jobNumber}</span> {n.job.name}
                          </span>
                        ) : null,
                        <span key="type" className="text-ink-subtle">
                          {NOTIFICATION_TYPE_META[n.type]?.label ?? "Notification"}
                        </span>,
                      ]
                        .filter(Boolean)
                        .map((part, i) => (
                          <React.Fragment key={i}>
                            {i > 0 ? (
                              <span aria-hidden="true" className="text-ink-subtle">
                                ·
                              </span>
                            ) : null}
                            {part}
                          </React.Fragment>
                        ))}
                    </div>
                  </div>
                  <div className="relative z-[1] flex shrink-0 flex-col items-end gap-1">
                    <RelativeTime value={n.createdAt} timeZone={timeZone} className="text-xs text-ink-subtle" />
                    {unread ? (
                      <IconButton
                        label={`Mark “${n.title}” as read`}
                        size="xs"
                        className="opacity-100 sm:opacity-0 sm:group-hover/notif:opacity-100 sm:focus-visible:opacity-100"
                        onClick={async () => {
                          if (await markRead(n)) router.refresh();
                        }}
                      >
                        <Check aria-hidden="true" />
                      </IconButton>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      {cursor ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={loadMore} loading={loadingMore}>
            Load older notifications
          </Button>
        </div>
      ) : items.length > 10 ? (
        <p className="flex items-center justify-center gap-1.5 text-xs text-ink-subtle">
          <CheckCheck aria-hidden="true" className="size-3.5" />
          That&apos;s everything
        </p>
      ) : null}
    </div>
  );
}

export interface MarkAllReadButtonProps {
  unreadCount: number;
}

/** "Mark all read" (POST /api/notifications/read-all), then refresh the centre and the bell. */
export function MarkAllReadButton({ unreadCount }: MarkAllReadButtonProps) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  return (
    <Button
      variant="outline"
      leadingIcon={<CheckCheck aria-hidden="true" />}
      disabled={unreadCount === 0}
      loading={pending}
      onClick={async () => {
        setPending(true);
        try {
          const res = await api.post<{ updated: number }>("/api/notifications/read-all");
          toast.success(res.updated === 1 ? "1 notification marked as read" : `${res.updated} notifications marked as read`);
          router.refresh();
        } catch (err) {
          toast.error(errorMessage(err));
        } finally {
          setPending(false);
        }
      }}
    >
      Mark all read
    </Button>
  );
}
