import type { Metadata } from "next";
import Link from "next/link";
import { BellOff, CheckCheck, Settings2 } from "lucide-react";
import { MarkAllReadButton, NotificationList } from "@/components/notifications";
import { PageContainer } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import { guard, load, pageContext, param } from "@/server/page";
import { listNotifications, unreadCount } from "@/server/queries/notifications";

export const metadata: Metadata = { title: "Notifications" };

const PAGE_SIZE = 40;

/** Notification centre: Unread / All, grouped by day, mark one or all read. Which kinds you hear about is set in My account. */
export default async function NotificationsPage({ searchParams }: PageProps<"/notifications">) {
  const sp = await searchParams;
  const filter = param(sp, "filter") === "all" ? "all" : "unread";
  const { ctx, db } = await pageContext();
  if (ctx.userId) guard(ctx, "notification.read", { userId: ctx.userId, organisationId: ctx.organisationId });

  const unread = await load(() => unreadCount(db, ctx));
  const page = await load(() => listNotifications(db, ctx, { unread: filter === "unread", limit: PAGE_SIZE }));
  const tz = ctx.settings.timezone;

  const tabs = [
    { value: "unread", label: "Unread", href: "/notifications", count: unread },
    { value: "all", label: "All", href: "/notifications?filter=all", count: null },
  ] as const;

  return (
    <PageContainer width="narrow">
      <PageHeader
        title="Notifications"
        description={unread > 0 ? `You have ${unread} unread ${unread === 1 ? "notification" : "notifications"}.` : "You're all caught up."}
        actions={
          <>
            <MarkAllReadButton unreadCount={unread} />
            <Button variant="ghost" href="/settings/account#notifications" leadingIcon={<Settings2 aria-hidden="true" />}>
              Choose what you hear about
            </Button>
          </>
        }
      >
        <nav aria-label="Notification filter" className="flex items-center gap-1 border-b border-border">
          {tabs.map((tab) => {
            const active = tab.value === filter;
            return (
              <Link
                key={tab.value}
                href={tab.href}
                scroll={false}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative -mb-px inline-flex h-10 items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors focus-ring-inset",
                  active ? "border-accent text-ink" : "border-transparent text-ink-muted hover:text-ink",
                )}
              >
                {tab.label}
                {tab.count ? (
                  <span className="numeric rounded-full bg-accent-soft px-1.5 text-2xs font-semibold text-accent-ink">{tab.count}</span>
                ) : null}
              </Link>
            );
          })}
        </nav>
      </PageHeader>

      {page.items.length === 0 ? (
        filter === "unread" ? (
          <EmptyState
            bordered
            icon={CheckCheck}
            title="You're all caught up"
            description="Jobs given to you, work ready to check, changes asked, approvals, messages and client feedback land here."
            action={
              <Button variant="outline" href="/notifications?filter=all">
                View all notifications
              </Button>
            }
          />
        ) : (
          <EmptyState
            bordered
            icon={BellOff}
            title="No notifications yet"
            description="You are told when a job is given to you, when something is ready to check, when changes are asked, and when someone writes to you."
            action={
              <Button variant="outline" href="/settings/account#notifications">
                Choose what you hear about
              </Button>
            }
          />
        )
      ) : (
        <NotificationList
          key={`${filter}:${unread}:${page.items[0]?.id ?? ""}`}
          initialItems={page.items}
          initialCursor={page.nextCursor}
          filter={filter}
          timeZone={tz}
        />
      )}
    </PageContainer>
  );
}
