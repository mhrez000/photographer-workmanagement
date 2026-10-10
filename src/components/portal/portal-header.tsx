"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, CircleUser, Images, LogOut } from "lucide-react";
import { BrandMark } from "@/components/shell/brand-mark";
import { Avatar } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { LOGOUT_ACTION, isNavItemActive } from "@/config/nav";
import { cn } from "@/lib/utils";

export interface PortalHeaderProps {
  studioName: string;
  clientName: string;
  user: { name: string; email: string; avatarColour: string };
  unreadCount: number;
}

const WORK = { href: "/portal", label: "Shared work", exact: false } as const;

/** Portal chrome: brand + studio/client, Shared work, bell, account menu (Account, Log out). No sidebar, no search. */
export function PortalHeader({ studioName, clientName, user, unreadCount }: PortalHeaderProps) {
  const pathname = usePathname() ?? "/portal";
  const workActive =
    pathname === "/portal" || pathname.startsWith("/portal/jobs") || pathname.startsWith("/portal/projects");
  const notificationsActive = isNavItemActive(pathname, { href: "/portal/notifications" });
  const accountActive = isNavItemActive(pathname, { href: "/portal/account" });
  const unreadLabel = unreadCount > 99 ? "99+" : String(unreadCount);

  return (
    <header className="sticky top-0 z-(--z-topbar) border-b border-border bg-surface/90 backdrop-blur supports-[backdrop-filter]:bg-surface/75">
      <div className="mx-auto flex h-16 max-w-5xl items-center gap-3 px-4 sm:px-6">
        <Link href="/portal" className="flex min-w-0 items-center gap-2.5 rounded-md focus-ring" aria-label={`${studioName} — your work`}>
          <BrandMark size={30} />
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-sm font-semibold text-ink">{studioName}</span>
            <span className="truncate text-xs text-ink-muted">{clientName}</span>
          </span>
        </Link>

        <nav aria-label="Portal" className="ml-auto flex items-center gap-1">
          <Link
            href={WORK.href}
            aria-current={workActive ? "page" : undefined}
            className={cn(
              "hidden h-9 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors focus-ring sm:inline-flex",
              workActive ? "bg-surface-muted text-ink" : "text-ink-secondary hover:bg-surface-muted hover:text-ink",
            )}
          >
            <Images aria-hidden="true" className="size-4" />
            {WORK.label}
          </Link>
          <Link
            href="/portal/notifications"
            aria-current={notificationsActive ? "page" : undefined}
            aria-label={unreadCount > 0 ? `Notifications, ${unreadLabel} unread` : "Notifications"}
            className={cn(
              "relative inline-flex size-10 items-center justify-center rounded-md transition-colors focus-ring",
              notificationsActive ? "bg-surface-muted text-ink" : "text-ink-secondary hover:bg-surface-muted hover:text-ink",
            )}
          >
            <Bell aria-hidden="true" className="size-5" />
            {unreadCount > 0 ? (
              <span
                aria-hidden="true"
                className="numeric absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-2xs font-semibold text-accent-fg ring-2 ring-surface"
              >
                {unreadLabel}
              </span>
            ) : null}
          </Link>

          <DropdownMenu>
            <DropdownMenuTrigger
              variant="ghost"
              size="sm"
              aria-label={`Account menu for ${user.name}`}
              className={cn("h-10 gap-2 rounded-full pl-1 pr-1 sm:pr-2.5", accountActive && "bg-surface-muted")}
            >
              <Avatar name={user.name} size="md" colour={user.avatarColour} className="size-8" />
              <span className="hidden max-w-36 truncate text-sm font-medium text-ink md:inline">{user.name}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" aria-label="Account" className="w-72">
              <div className="flex items-center gap-3 px-2.5 py-2">
                <Avatar name={user.name} size="lg" colour={user.avatarColour} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-base font-medium text-ink">{user.name}</div>
                  <div className="truncate text-xs text-ink-muted">{user.email}</div>
                  <div className="truncate text-xs text-ink-muted">{clientName}</div>
                </div>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem href="/portal" icon={<Images aria-hidden="true" />}>
                Shared work
              </DropdownMenuItem>
              <DropdownMenuItem href="/portal/notifications" icon={<Bell aria-hidden="true" />}>
                Notifications
              </DropdownMenuItem>
              <DropdownMenuItem href="/portal/account" icon={<CircleUser aria-hidden="true" />}>
                Profile & password
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <form action={LOGOUT_ACTION} method="post" className="contents">
                <DropdownMenuItem type="submit" keepOpen destructive icon={<LogOut aria-hidden="true" />}>
                  Log out
                </DropdownMenuItem>
              </form>
            </DropdownMenuContent>
          </DropdownMenu>
        </nav>
      </div>
    </header>
  );
}
