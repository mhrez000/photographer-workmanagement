"use client";

import * as React from "react";
import { Building2 } from "lucide-react";
import { MultiSelect } from "@/components/filters/multi-select";
import { Switch } from "@/components/ui/switch";
import { useUrlState } from "@/hooks/use-url-state";
import { cn } from "@/lib/utils";
import { UrlSearchInput } from "./url-search";

export interface ListToolbarProps {
  searchPlaceholder: string;
  /** Client facet (projects list). */
  clients?: { id: string; name: string; colour: string }[];
  className?: string;
}

/** Search (`?q`), client filter (`?clientId`) and "Show archived" (`?archived=1`), all in the URL. */
export function ListToolbar({ searchPlaceholder, clients, className }: ListToolbarProps) {
  const url = useUrlState();
  const archived = url.get("archived") === "1";
  const clientId = url.get("clientId");

  return (
    <div className={cn("flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between", className)}>
      <div className="flex flex-1 flex-wrap items-center gap-2">
        <UrlSearchInput placeholder={searchPlaceholder} className="w-full sm:w-72" size="sm" />
        {clients ? (
          <MultiSelect
            label="Client"
            icon={Building2}
            single
            searchable
            options={clients.map((c) => ({ value: c.id, label: c.name, colour: c.colour }))}
            value={clientId ? [clientId] : []}
            onChange={(next) => url.set("clientId", next[0] ?? null)}
          />
        ) : null}
      </div>
      <Switch size="sm" label="Show archived" checked={archived} onCheckedChange={(on) => url.set("archived", on ? "1" : null)} />
    </div>
  );
}
