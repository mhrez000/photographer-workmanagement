"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useHotkeys } from "@/hooks/use-hotkeys";
import { useUrlState } from "@/hooks/use-url-state";
import { cn } from "@/lib/utils";
import { TIMELINE_GROUP_LABELS, TIMELINE_GROUPS, shiftCivil, type TimelineGroup, type TimelineWindow } from "./timeline-utils";

export interface TimelineToolbarProps {
  from: string;
  weeks: TimelineWindow;
  group: TimelineGroup;
  /** "6 Oct – 2 Nov 2026" */
  rangeLabel: string;
  /** The window already starts at the default (today) position. */
  atDefault: boolean;
  /** Group modes offered (photographers/editors get fewer). */
  groups?: readonly TimelineGroup[];
}

/** Window (2/4/8 weeks), prev/next/today and grouping — all URL state. */
export function TimelineToolbar({ from, weeks, group, rangeLabel, atDefault, groups = TIMELINE_GROUPS }: TimelineToolbarProps) {
  const url = useUrlState();
  const step = (dir: 1 | -1) => url.set("from", shiftCivil(from, dir * weeks * 7));
  useHotkeys({ "[": () => step(-1), "]": () => step(1), t: () => url.set("from", null) });

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          <IconButton label="Earlier ([)" variant="outline" size="sm" onClick={() => step(-1)}>
            <ChevronLeft />
          </IconButton>
          <IconButton label="Later (])" variant="outline" size="sm" onClick={() => step(1)}>
            <ChevronRight />
          </IconButton>
        </div>
        <Button variant="outline" size="sm" onClick={() => url.set("from", null)} disabled={atDefault} title="Today (t)">
          Today
        </Button>
        <h2 className={cn("numeric ml-1 truncate text-lg font-semibold tracking-tight text-ink", url.isPending && "opacity-60")} aria-live="polite">
          {rangeLabel}
        </h2>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl<string>
          aria-label="Time window"
          size="sm"
          value={String(weeks)}
          onValueChange={(v) => url.patch({ weeks: v === "4" ? null : v, from: null })}
          options={[
            { value: "2", label: "2 weeks" },
            { value: "4", label: "4 weeks" },
            { value: "8", label: "8 weeks" },
          ]}
        />
        <SegmentedControl<TimelineGroup>
          aria-label="Group rows by"
          size="sm"
          value={group}
          onValueChange={(v) => url.set("group", v === "editor" ? null : v)}
          options={groups.map((g) => ({ value: g, label: TIMELINE_GROUP_LABELS[g] }))}
        />
      </div>
    </div>
  );
}
