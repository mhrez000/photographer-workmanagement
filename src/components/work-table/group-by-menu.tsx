"use client";

import * as React from "react";
import { ChevronDown, Rows3 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUrlState } from "@/hooks/use-url-state";
import { GROUP_BY_LABELS, WORK_GROUP_BY, isWorkGroupBy, type WorkGroupBy } from "./columns";

export interface GroupByMenuProps {
  /** Group options offered (default: all). */
  options?: readonly WorkGroupBy[];
  className?: string;
}

/** Writes `?groupBy=` (server re-renders the grouped table). */
export function GroupByMenu({ options = WORK_GROUP_BY, className }: GroupByMenuProps) {
  const url = useUrlState();
  const raw = url.get("groupBy");
  const current = isWorkGroupBy(raw) ? raw : null;

  return (
    <DropdownMenu className={className}>
      <DropdownMenuTrigger
        variant={current ? "secondary" : "outline"}
        size="sm"
        leadingIcon={<Rows3 aria-hidden="true" />}
        trailingIcon={<ChevronDown aria-hidden="true" className="text-ink-subtle" />}
        aria-label={current ? `Grouped by ${GROUP_BY_LABELS[current]}` : "Group rows"}
        loading={url.isPending}
      >
        <span className="hidden sm:inline">{current ? `Group: ${GROUP_BY_LABELS[current]}` : "Group"}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label="Group rows by" width="13rem">
        <DropdownMenuLabel>Group by</DropdownMenuLabel>
        <DropdownMenuItem checked={current === null} onSelect={() => url.set("groupBy", null)}>
          No grouping
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {options.map((option) => (
          <DropdownMenuItem key={option} checked={current === option} onSelect={() => url.set("groupBy", option)}>
            {GROUP_BY_LABELS[option]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
