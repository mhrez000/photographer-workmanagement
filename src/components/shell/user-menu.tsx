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
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ROLE_LABELS, type ShellUser } from "./types";

export interface UserMenuProps {
  user: ShellUser;
  /** POST target for the logout form. */
  logoutAction: string;
  /** Show name + chevron next to the avatar (desktop). */
  showName?: boolean;
  className?: string;
}

/** Avatar trigger → account menu with profile links and a POST logout form. */
export function UserMenu({ user, logoutAction, showName = true, className }: UserMenuProps) {
  return (
    <DropdownMenu className={className}>
      <DropdownMenuTrigger
        variant="ghost"
        size="sm"
        aria-label={`Account menu for ${user.name}`}
        className={cn("h-9 gap-2 rounded-full pl-1 pr-1", showName && "sm:pr-2")}
      >
        <Avatar name={user.name} size="md" colour={user.avatarColour ?? undefined} className="size-7" />
        {showName ? (
          <>
            <span className="hidden max-w-32 truncate text-sm font-medium text-ink sm:inline">{user.name}</span>
            <ChevronDown aria-hidden="true" className="hidden size-3.5 text-ink-subtle sm:inline" />
          </>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label="Account" className="w-64">
        <div className="flex items-center gap-3 px-2.5 py-2">
          <Avatar name={user.name} size="lg" colour={user.avatarColour ?? undefined} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-medium text-ink">{user.name}</div>
            <div className="truncate text-xs text-ink-muted">{user.email}</div>
          </div>
          <Badge variant="outline" size="sm">
            {ROLE_LABELS[user.role]}
          </Badge>
        </div>
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
