"use client";

import * as React from "react";
import { CalendarDays, List, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useUrlState } from "@/hooks/use-url-state";
import { cn } from "@/lib/utils";
import type { JobsUrlState, JobsView } from "./params";

export interface FilterOption {
  value: string;
  label: string;
}

export interface JobsFiltersProps {
  state: JobsUrlState;
  /** Active editors (plus "No editor yet"). Empty = hide the Editor filter. */
  editors: FilterOption[];
  /** Non-archived clients. Empty = hide the Client filter. */
  clients: FilterOption[];
  /** Late count under the current search / editor / client filters. */
  lateCount: number;
  cancelledCount: number;
  /** Hide the List / Calendar switch (the editor's Calendar page). */
  hideViewSwitch?: boolean;
  /** Hide Late / Show cancelled (the calendar shows every active job's dates; cancelled jobs never). */
  hideStageFilters?: boolean;
  className?: string;
}

/**
 * Search / Editor / Client, the Late and Show cancelled filters, and the List / Calendar switch
 * (docs/SIMPLIFICATION-PLAN.md §8 "Kept, and polished"). Everything lives in the URL.
 * No saved views, group-by, column chooser or bulk actions here (Advanced only).
 */
export function JobsFilters({ state, editors, clients, lateCount, cancelledCount, hideViewSwitch = false, hideStageFilters = false, className }: JobsFiltersProps) {
  const url = useUrlState();
  const applied = Boolean(state.q || state.editorId || state.clientId || (!hideStageFilters && (state.late || state.showCancelled)));

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <SearchInput
          key={state.q}
          defaultValue={state.q}
          placeholder="Search address, client or job number…"
          aria-label="Search jobs"
          onDebouncedChange={(value) => {
            if (value.trim() !== state.q) url.set("q", value.trim() || null);
          }}
          onClear={() => url.set("q", null)}
          wrapperClassName="w-full sm:w-72"
        />
        <div className="flex flex-wrap items-center gap-2">
          {editors.length > 0 ? (
            <Select
              size="sm"
              aria-label="Editor"
              value={state.editorId}
              onChange={(e) => url.set("editorId", e.target.value || null)}
              wrapperClassName="w-full sm:w-44"
            >
              <option value="">Any editor</option>
              <option value="none">No editor yet</option>
              {editors.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          ) : null}
          {clients.length > 0 ? (
            <Select
              size="sm"
              aria-label="Client"
              value={state.clientId}
              onChange={(e) => url.set("clientId", e.target.value || null)}
              wrapperClassName="w-full sm:w-48"
            >
              <option value="">Any client</option>
              {clients.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          ) : null}
        </div>
        {!hideViewSwitch ? (
          <div className="sm:ml-auto">
            <SegmentedControl<JobsView>
              aria-label="List or calendar"
              size="sm"
              value={state.view}
              onValueChange={(v) => url.patch({ view: v === "calendar" ? "calendar" : null, month: null })}
              options={[
                { value: "list", label: "List", icon: <List aria-hidden="true" /> },
                { value: "calendar", label: "Calendar", icon: <CalendarDays aria-hidden="true" /> },
              ]}
            />
          </div>
        ) : null}
      </div>
      <div className={cn("flex flex-wrap items-center gap-x-5 gap-y-2 text-sm", url.isPending && "opacity-60", hideStageFilters && !applied && "hidden")}>
        {!hideStageFilters ? (
          <>
            <Switch
              size="sm"
              checked={state.late}
              onCheckedChange={(next) => url.set("late", next ? "1" : null)}
              label={
                <span className={cn("text-sm", lateCount > 0 ? "font-medium text-danger-fg" : "text-ink-secondary")}>
                  Late{lateCount > 0 ? ` · ${lateCount}` : ""}
                </span>
              }
              wrapperClassName="h-8 items-center"
            />
            <Switch
              size="sm"
              checked={state.showCancelled}
              onCheckedChange={(next) => url.set("cancelled", next ? "1" : null)}
              label={<span className="text-sm text-ink-secondary">Show cancelled{cancelledCount > 0 ? ` · ${cancelledCount}` : ""}</span>}
              wrapperClassName="h-8 items-center"
            />
          </>
        ) : null}
        {applied ? (
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<X aria-hidden="true" />}
            onClick={() => url.clear(["q", "editorId", "clientId", "late", "cancelled", "cursor"])}
            className="ml-auto"
          >
            Clear filters
          </Button>
        ) : null}
      </div>
    </div>
  );
}
