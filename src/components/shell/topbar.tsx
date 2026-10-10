"use client";

import * as React from "react";
import Link from "next/link";
import { Bell, ChevronRight, Menu, Plus, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NavMatch, QuickAction, RouteTitle } from "@/config/nav";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip } from "@/components/ui/tooltip";
import type { ViewScope } from "@/lib/constants";
import { ScopeSwitch } from "./scope-switch";
import { UserMenu } from "./user-menu";
import type { ShellUser } from "./types";

export interface TopbarProps {
  user: ShellUser;
  unreadCount: number;
  /** Nav match for the current route (legacy input; `heading` wins when given). */
  match?: NavMatch | null;
  /** Resolved title + eyebrow for the current route (see `resolveRouteTitle`). */
  heading?: RouteTitle | null;
  /** Overrides the derived page title. */
  title?: React.ReactNode;
  isMac: boolean;
  onOpenMenu: () => void;
  onOpenSearch: () => void;
  primaryAction?: QuickAction;
  logoutAction: string;
  /**
   * Personal vs business view (docs/ROLES.md §8): the resolved scope for viewers
   * who may switch (`view.business_scope`), else null/undefined (no switch).
   */
  viewScope?: ViewScope | null;
}

function formatCount(count: number): string {
  if (count > 99) return "99+";
  return String(count);
}

/** Sticky header: menu (mobile), breadcrumb, search, bell, New job, account. */
export function Topbar({
  user,
  unreadCount,
  match = null,
  heading,
  title,
  isMac,
  onOpenMenu,
  onOpenSearch,
  primaryAction,
  logoutAction,
  viewScope = null,
}: TopbarProps) {
  const resolved = heading ?? (match ? { title: match.item.label, eyebrow: match.group.label } : null);
  const eyebrow = resolved?.eyebrow;
  const pageTitle = title ?? resolved?.title ?? "Proofline";
  const PrimaryIcon = primaryAction?.icon ?? Plus;

  return (
    <header
      className={cn(
        "sticky top-0 z-(--z-topbar) flex h-(--topbar-height) shrink-0 items-center gap-2 border-b border-border px-3 sm:px-4 lg:px-6",
        "bg-canvas/85 backdrop-blur supports-[backdrop-filter]:bg-canvas/75",
      )}
    >
      <IconButton label="Open navigation" onClick={onOpenMenu} className="lg:hidden" variant="ghost">
        <Menu />
      </IconButton>

      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {eyebrow ? (
          <>
            <span className="hidden text-sm text-ink-muted sm:inline">{eyebrow}</span>
            <ChevronRight aria-hidden="true" className="hidden size-3.5 text-ink-subtle sm:inline" />
          </>
        ) : null}
        {/* Not a heading: every page owns its <h1> (PageHeader); this is a location label. */}
        <p data-topbar-title="" className="truncate text-base font-semibold tracking-tight text-ink">
          {pageTitle}
        </p>
      </div>

      <div className="flex items-center gap-1 sm:gap-1.5">
        {viewScope ? <ScopeSwitch scope={viewScope} className="mr-1 hidden md:inline-flex" /> : null}
        <button
          type="button"
          onClick={onOpenSearch}
          aria-label="Search"
          aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
          className={cn(
            "hidden h-9 w-56 items-center gap-2 rounded-md border border-border bg-surface px-3 text-sm text-ink-muted shadow-xs md:flex xl:w-72",
            // Leave room for the scope switch on tablet widths.
            viewScope && "w-40 lg:w-48",
            "transition-[border-color,box-shadow] duration-(--motion-fast) hover:border-border-hover hover:text-ink focus-ring",
          )}
        >
          <Search aria-hidden="true" className="size-4 shrink-0 text-ink-subtle" />
          <span className="flex-1 truncate text-left">Search jobs, clients, people…</span>
          <Kbd keys={isMac ? ["⌘", "K"] : ["Ctrl", "K"]} className="hidden lg:inline-flex" />
        </button>
        <IconButton label="Search" onClick={onOpenSearch} className="md:hidden">
          <Search />
        </IconButton>

        <Tooltip content={unreadCount > 0 ? `${unreadCount} unread notifications` : "Notifications"} side="bottom">
          <Link
            href="/notifications"
            aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
            className="relative inline-flex size-9 items-center justify-center rounded-md text-ink-muted transition-colors duration-(--motion-fast) hover:bg-surface-muted hover:text-ink focus-ring"
          >
            <Bell aria-hidden="true" className="size-4" />
            {unreadCount > 0 ? (
              <span
                aria-hidden="true"
                className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-attention px-1 text-[10px] font-semibold leading-none text-white ring-2 ring-canvas numeric"
              >
                {formatCount(unreadCount)}
              </span>
            ) : null}
          </Link>
        </Tooltip>

        {primaryAction ? (
          <>
            <Button
              href={primaryAction.href}
              size="sm"
              leadingIcon={<PrimaryIcon aria-hidden="true" />}
              className="hidden sm:inline-flex"
            >
              {primaryAction.label}
            </Button>
            <IconButton label={primaryAction.label} href={primaryAction.href} variant="primary" size="md" className="sm:hidden">
              <PrimaryIcon />
            </IconButton>
          </>
        ) : null}

        <UserMenu user={user} logoutAction={logoutAction} viewScope={viewScope} nameFrom={viewScope ? "xl" : "sm"} className="ml-0.5" />
      </div>
    </header>
  );
}
