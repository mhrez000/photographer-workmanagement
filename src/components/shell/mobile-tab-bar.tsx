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
}

/** Bottom tab bar for phones/tablets (hidden at lg+). */
export function MobileTabBar({ tabs, pathname, onOpenSearch, onOpenMore, moreOpen = false }: MobileTabBarProps) {
  return (
    <nav
      aria-label="Primary"
      className={cn(
        "fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 backdrop-blur safe-bottom lg:hidden",
      )}
    >
      <ul className="flex h-(--tabbar-height) items-stretch">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = tab.href ? isNavItemActive(pathname, { href: tab.href }) : tab.action === "more" && moreOpen;
          const classes = cn(
            "flex h-full w-full flex-col items-center justify-center gap-1 text-[11px] font-medium leading-none",
            "transition-colors duration-(--motion-fast) focus-ring-inset",
            active ? "text-accent-ink" : "text-ink-muted hover:text-ink",
          );
          const icon = (
            <span
              className={cn(
                "flex h-7 w-12 items-center justify-center rounded-full transition-colors duration-(--motion-base)",
                active && "bg-accent-soft",
              )}
            >
              <Icon aria-hidden="true" className="size-5" strokeWidth={active ? 2.25 : 2} />
            </span>
          );

          return (
            <li key={tab.id} className="flex min-w-0 flex-1">
              {tab.href ? (
                <Link href={tab.href} aria-current={active ? "page" : undefined} className={classes}>
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
