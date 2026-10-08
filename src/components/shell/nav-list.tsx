"use client";

import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { isNavItemActive, type NavGroup } from "@/config/nav";
import { RailTooltip } from "./rail-tooltip";

export interface NavListProps {
  groups: NavGroup[];
  pathname: string;
  /** Icon-rail mode: labels hidden, tooltips shown. */
  collapsed?: boolean;
  /** Called after a link is activated (close the mobile sheet). */
  onNavigate?: () => void;
  className?: string;
}

/** Grouped navigation list shared by the desktop sidebar and mobile drawer. */
export function NavList({ groups, pathname, collapsed = false, onNavigate, className }: NavListProps) {
  return (
    <nav aria-label="Main" className={cn("flex flex-col gap-4", className)}>
      {groups.map((group, groupIndex) => (
        <div key={group.id} className="flex flex-col">
          {group.label ? (
            collapsed ? (
              groupIndex > 0 ? <div aria-hidden="true" className="mx-3 mb-2 h-px bg-border" /> : null
            ) : (
              <div className="mb-1 px-2.5 eyebrow">{group.label}</div>
            )
          ) : null}
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = isNavItemActive(pathname, item);
              const Icon = item.icon;
              const link = (
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  aria-label={collapsed ? item.label : undefined}
                  onClick={onNavigate}
                  className={cn(
                    "group/nav relative flex h-8 items-center gap-2.5 rounded-sm px-2.5 text-sm font-medium",
                    "transition-colors duration-(--motion-fast) focus-ring",
                    active
                      ? "bg-accent-soft text-accent-ink"
                      : "text-ink-secondary hover:bg-surface-muted hover:text-ink",
                    collapsed && "w-9 justify-center px-0",
                  )}
                >
                  <Icon
                    aria-hidden="true"
                    className={cn(
                      "size-4 shrink-0",
                      active ? "text-accent-ink" : "text-ink-muted group-hover/nav:text-ink",
                    )}
                    strokeWidth={active ? 2.25 : 2}
                  />
                  {!collapsed ? <span className="truncate">{item.label}</span> : null}
                  {active && !collapsed ? (
                    <span
                      aria-hidden="true"
                      className="absolute -left-2 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent"
                    />
                  ) : null}
                </Link>
              );

              return (
                <li key={item.id} className={cn(collapsed && "flex justify-center")}>
                  {collapsed ? <RailTooltip content={item.label}>{link}</RailTooltip> : link}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
