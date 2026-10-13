"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { Building2, CircleUser, History, Tag, Users } from "lucide-react";
import { isAdvancedRoute } from "@/config/nav";
import { cn } from "@/lib/utils";

export interface SettingsTab {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Admins only (`settings.view`). */
  admin?: boolean;
}

/** The one Settings entry (docs/SIMPLIFICATION-PLAN.md §3): Studio · People · Types of shoot · My account · History. */
export const SETTINGS_TABS: readonly SettingsTab[] = [
  { href: "/settings/studio", label: "Studio", icon: Building2, admin: true },
  { href: "/settings/people", label: "People", icon: Users, admin: true },
  { href: "/settings/shoot-types", label: "Types of shoot", icon: Tag, admin: true },
  { href: "/settings/account", label: "My account", icon: CircleUser },
  { href: "/settings/history", label: "History", icon: History, admin: true },
];

export function settingsTabsFor(isAdmin: boolean): SettingsTab[] {
  return SETTINGS_TABS.filter((t) => isAdmin || !t.admin);
}

/** Longest-prefix match so /settings/people/abc highlights "People". */
export function activeSettingsTab(pathname: string, tabs: readonly SettingsTab[]): string | null {
  let best: string | null = null;
  for (const t of tabs) {
    if ((pathname === t.href || pathname.startsWith(`${t.href}/`)) && (!best || t.href.length > best.length)) best = t.href;
  }
  return best;
}

/**
 * Tab strip under the topbar. Hidden on the Advanced pages that also live under
 * /settings (Workflows, Automations, Teams, Roles): they are reached from the Advanced
 * group in the menu and keep their own headers. Non-admins only have My account, so
 * the strip is not shown to them either (one tab is not a choice).
 */
export function SettingsTabs({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const tabs = React.useMemo(() => settingsTabsFor(isAdmin), [isAdmin]);
  if (isAdvancedRoute(pathname) || tabs.length < 2) return null;
  const active = activeSettingsTab(pathname, tabs);

  return (
    <div className="border-b border-border bg-canvas">
      <nav aria-label="Settings" className="mx-auto flex w-full max-w-[1440px] gap-1 overflow-x-auto px-4 scrollbar-none sm:px-6 lg:px-8" data-settings-tabs="">
        {tabs.map((t) => {
          const Icon = t.icon;
          const isActive = t.href === active;
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex h-11 shrink-0 items-center gap-2 border-b-2 px-2.5 text-sm font-medium whitespace-nowrap transition-colors duration-(--motion-fast) focus-ring-inset",
                isActive ? "border-accent text-ink" : "border-transparent text-ink-muted hover:text-ink",
              )}
            >
              <Icon aria-hidden="true" className={cn("size-4", isActive ? "text-accent-ink" : "text-ink-subtle")} />
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
