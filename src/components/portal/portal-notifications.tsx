"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck, Images, MessageSquareReply, PackageCheck } from "lucide-react";
import { RelativeTime } from "@/components/jobs/relative-time";
import { useMutationRunner } from "@/components/jobs/mutation";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { api } from "@/lib/api-client";
import type { ClientNotificationType } from "@/lib/constants";
import { cn } from "@/lib/utils";

export interface PortalNotificationItem {
  id: string;
  type: ClientNotificationType;
  title: string;
  body: string | null;
  linkPath: string;
  readAt: string | null;
  createdAt: string;
}

const ICONS: Record<ClientNotificationType, React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  client_work_shared: Images,
  client_work_delivered: PackageCheck,
  client_feedback_reply: MessageSquareReply,
};

/** The client's notifications (newest first); opening one marks it read. */
export function PortalNotifications({ items, timeZone }: { items: PortalNotificationItem[]; timeZone: string }) {
  const router = useRouter();
  const run = useMutationRunner();
  const unread = items.filter((n) => n.readAt === null).length;

  async function open(n: PortalNotificationItem) {
    if (n.readAt === null) {
      try {
        await api.post(`/api/portal/notifications/${n.id}/read`);
      } catch {
        // marking read is best-effort; navigation still happens
      }
    }
    router.push(n.linkPath);
    router.refresh();
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={Bell}
        bordered
        title="You're all caught up"
        description="We'll let you know here when your studio shares work, delivers it or replies to you."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-ink-muted">{unread > 0 ? `${unread} unread` : "Everything is read"}</p>
        {unread > 0 ? (
          <Button
            variant="outline"
            size="sm"
            leadingIcon={<CheckCheck aria-hidden="true" />}
            onClick={() => void run(() => api.post("/api/portal/notifications/read-all"), { success: "Marked all as read" })}
          >
            Mark all as read
          </Button>
        ) : null}
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
        {items.map((n) => {
          const Icon = ICONS[n.type];
          const isUnread = n.readAt === null;
          return (
            <li key={n.id}>
              <Link
                href={n.linkPath}
                onClick={(e) => {
                  e.preventDefault();
                  void open(n);
                }}
                className={cn("flex gap-3 px-4 py-3.5 transition-colors hover:bg-surface-muted focus-ring-inset", isUnread && "bg-accent-soft/40")}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full",
                    isUnread ? "bg-accent text-accent-fg" : "bg-surface-muted text-ink-muted",
                  )}
                >
                  <Icon aria-hidden={true} className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-sm text-ink", isUnread && "font-semibold")}>{n.title}</span>
                  {n.body ? <span className="mt-0.5 block whitespace-pre-wrap break-words text-sm text-ink-secondary">{n.body}</span> : null}
                  <RelativeTime value={n.createdAt} timeZone={timeZone} className="mt-1 block text-xs text-ink-muted" />
                </span>
                {isUnread ? <span className="sr-only">Unread</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
