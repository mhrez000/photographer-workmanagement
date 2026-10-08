"use client";

import * as React from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NavGroup } from "@/config/nav";
import { Kbd } from "@/components/ui/kbd";
import { Brand } from "./brand-mark";
import { NavList } from "./nav-list";
import { RailTooltip } from "./rail-tooltip";

export interface SidebarProps {
  groups: NavGroup[];
  pathname: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  orgName: string;
}

/** Desktop sidebar: 264px expanded, 72px icon rail when collapsed. */
export function Sidebar({ groups, pathname, collapsed, onToggleCollapsed, orgName }: SidebarProps) {
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";

  const toggle = (
    <button
      type="button"
      onClick={onToggleCollapsed}
      aria-label={toggleLabel}
      aria-expanded={!collapsed}
      className={cn(
        "flex h-8 items-center gap-2 rounded-sm text-sm text-ink-muted transition-colors duration-(--motion-fast) hover:bg-surface-muted hover:text-ink focus-ring",
        collapsed ? "w-9 justify-center" : "w-full px-2.5",
      )}
    >
      <ToggleIcon aria-hidden="true" className="size-4 shrink-0" />
      {!collapsed ? (
        <>
          <span className="flex-1 text-left">Collapse</span>
          <Kbd keys={["["]} />
        </>
      ) : null}
    </button>
  );

  return (
    <aside
      data-collapsed={collapsed || undefined}
      className={cn(
        "fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-border bg-surface lg:flex",
        "transition-[width] duration-(--motion-slow) ease-out-soft",
        collapsed ? "w-(--sidebar-width-collapsed)" : "w-(--sidebar-width)",
      )}
    >
      <div
        className={cn(
          "flex h-(--topbar-height) shrink-0 items-center border-b border-border",
          collapsed ? "justify-center px-0" : "px-4",
        )}
      >
        <Brand compact={collapsed} subtitle={orgName} className={cn(!collapsed && "w-full")} />
      </div>

      <div className={cn("flex-1 overflow-y-auto overflow-x-hidden py-4 scrollbar-thin", collapsed ? "px-0" : "px-3")}>
        <NavList groups={groups} pathname={pathname} collapsed={collapsed} />
      </div>

      <div className={cn("shrink-0 border-t border-border py-3", collapsed ? "flex justify-center px-0" : "px-3")}>
        {collapsed ? <RailTooltip content={toggleLabel}>{toggle}</RailTooltip> : toggle}
      </div>
    </aside>
  );
}
