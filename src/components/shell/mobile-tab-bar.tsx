"use client";

import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { isNavItemActive, type MobileTab } from "@/config/nav";

export interface MobileTabBarProps {
  tabs: MobileTab[];
  pathname: string;
  onOpenSearch: () => void;
  onOpenMore: () => void;
  /** Highlights the "More" tab while the drawer is open. */
  moreOpen?: boolean;
  /** Counts for tabs that carry a badge (plan §3: Home shows the red "to check" count). */
  badges?: Partial<Record<NonNullable<MobileTab["badge"]>, number>>;
}

function formatCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/**
 * Bottom tab bar for phones (hidden at lg+). Plan §3: Home (with a red "to check"
 * count) · Jobs · (+) New job · Editors · More for owners; My jobs · Calendar ·
 * Search · Me for editors. The (+) tab is the raised primary button.
 */
export function MobileTabBar({ tabs, pathname, onOpenSearch, onOpenMore, moreOpen = false, badges = {} }: MobileTabBarProps) {
  return (
    <nav
      aria-label="Primary"
      className={cn("fixed inset-x-0 bottom-0 z-(--z-shell) border-t border-border bg-surface/95 backdrop-blur safe-bottom lg:hidden")}
    >
      <ul className="flex h-(--tabbar-height) items-stretch">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = tab.href ? isNavItemActive(pathname, { href: tab.href }) : tab.action === "more" && moreOpen;
          const count = tab.badge ? (badges[tab.badge] ?? 0) : 0;

          if (tab.primary && tab.href) {
            return (
              <li key={tab.id} className="flex min-w-0 flex-1 items-center justify-center">
                <Link
                  href={tab.href}
                  aria-label={tab.label}
                  data-tab-primary=""
                  className={cn(
                    "-mt-5 flex size-13 items-center justify-center rounded-full bg-accent text-accent-fg shadow-pop ring-4 ring-canvas",
                    "transition-[transform,background-color] duration-(--motion-fast) hover:bg-accent-hover active:scale-95 focus-ring",
                  )}
                >
                  <Icon aria-hidden="true" className="size-6" strokeWidth={2.5} />
                </Link>
              </li>
            );
          }

          const classes = cn(
            "flex h-full w-full flex-col items-center justify-center gap-1 text-[11px] font-medium leading-none",
            "transition-colors duration-(--motion-fast) focus-ring-inset",
            active ? "text-accent-ink" : "text-ink-muted hover:text-ink",
          );
          const icon = (
            <span className={cn("relative flex h-7 w-12 items-center justify-center rounded-full transition-colors duration-(--motion-base)", active && "bg-accent-soft")}>
              <Icon aria-hidden="true" className="size-5" strokeWidth={active ? 2.25 : 2} />
              {count > 0 ? (
                <span
                  data-tab-badge={tab.badge}
                  className="absolute -top-0.5 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-attention px-1 text-[10px] font-semibold leading-none text-white ring-2 ring-surface numeric"
                >
                  {formatCount(count)}
                </span>
              ) : null}
            </span>
          );
          const label = count > 0 ? `${tab.label}, ${count} to check` : tab.label;

          return (
            <li key={tab.id} className="flex min-w-0 flex-1">
              {tab.href ? (
                <Link href={tab.href} aria-current={active ? "page" : undefined} aria-label={label} className={classes}>
                  {icon}
                  <span>{tab.label}</span>
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={tab.action === "search" ? onOpenSearch : onOpenMore}
                  aria-expanded={tab.action === "more" ? moreOpen : undefined}
                  className={classes}
                >
                  {icon}
                  <span>{tab.label}</span>
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
