"use client";

import * as React from "react";
import { ChevronDown, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { userMenuItems } from "@/config/nav";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { VIEW_SCOPE_LABELS, VIEW_SCOPES, type ViewScope } from "@/lib/constants";
import { SCOPE_ICONS, useScopeSwitch } from "./scope-switch";
import { shellRoleLabel, type ShellUser } from "./types";

export interface UserMenuProps {
  user: ShellUser;
  /** POST target for the logout form. */
  logoutAction: string;
  /** Show name + chevron next to the avatar (desktop). */
  showName?: boolean;
  /**
   * Width from which the name shows: `sm` (default) or `xl` — the topbar passes `xl` when it also
   * carries the scope switch, so tablet / small-laptop widths never scroll sideways.
   */
  nameFrom?: "sm" | "xl";
  className?: string;
  /** Scope switch (docs/ROLES.md §8): shown as radio items on small screens (the topbar carries it from md up). */
  viewScope?: ViewScope | null;
}

/** "Show" group: My shoots / Whole business as radio items (below md only). */
function ScopeMenuItems({ scope }: { scope: ViewScope }) {
  const { value, change } = useScopeSwitch(scope);
  return (
    <div className="md:hidden">
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Show</DropdownMenuLabel>
      <DropdownMenuGroup aria-label="Which work to show">
        {VIEW_SCOPES.map((s) => {
          const Icon = SCOPE_ICONS[s];
          return (
            <DropdownMenuItem
              key={s}
              role="menuitemradio"
              checked={value === s}
              onSelect={() => void change(s)}
            >
              <span className="inline-flex items-center gap-2">
                <Icon aria-hidden="true" className="size-4 text-ink-muted" />
                {VIEW_SCOPE_LABELS[s]}
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuGroup>
    </div>
  );
}

/** Avatar trigger → account menu with profile links and a POST logout form. */
export function UserMenu({ user, logoutAction, showName = true, nameFrom = "sm", className, viewScope = null }: UserMenuProps) {
  const wide = nameFrom === "xl";
  return (
    <DropdownMenu className={className}>
      <DropdownMenuTrigger
        variant="ghost"
        size="sm"
        aria-label={`Account menu for ${user.name}`}
        className={cn("h-9 gap-2 rounded-full pl-1 pr-1", showName && (wide ? "xl:pr-2" : "sm:pr-2"))}
      >
        <Avatar name={user.name} size="md" colour={user.avatarColour ?? undefined} className="size-7" />
        {showName ? (
          <>
            <span className={cn("hidden max-w-32 truncate text-sm font-medium text-ink", wide ? "xl:inline" : "sm:inline")}>{user.name}</span>
            <ChevronDown aria-hidden="true" className={cn("hidden size-3.5 text-ink-subtle", wide ? "xl:inline" : "sm:inline")} />
          </>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label="Account" className="w-72">
        <div className="flex items-center gap-3 px-2.5 py-2">
          <Avatar name={user.name} size="lg" colour={user.avatarColour ?? undefined} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-medium text-ink">{user.name}</div>
            <div className="truncate text-xs text-ink-muted">{user.email}</div>
            <Badge variant={user.role === "photographer" && user.isAdmin ? "solid" : user.role === "photographer" ? "info" : "neutral"} size="sm" className="mt-1 max-w-full" title={shellRoleLabel(user)}>
              <span className="truncate">{shellRoleLabel(user)}</span>
            </Badge>
          </div>
        </div>
        {viewScope ? <ScopeMenuItems scope={viewScope} /> : null}
        <DropdownMenuSeparator />
        {userMenuItems.map((item) => {
          const Icon = item.icon;
          return (
            <DropdownMenuItem key={item.id} href={item.href} icon={<Icon aria-hidden="true" />}>
              {item.label}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <form action={logoutAction} method="post" className="contents">
          <DropdownMenuItem type="submit" keepOpen destructive icon={<LogOut aria-hidden="true" />}>
            Log out
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
