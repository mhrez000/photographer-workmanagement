"use client";

import * as React from "react";
import { CalendarRange, Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger, usePopover } from "@/components/ui/popover";
import { useUrlState } from "@/hooks/use-url-state";
import { RANGE_PRESETS } from "@/lib/constants";
import { addCivilDays, resolveRange, todayCivil, type RangePreset } from "@/lib/dates";
import { cn } from "@/lib/utils";

export const RANGE_PRESET_LABELS: Record<RangePreset, string> = {
  today: "Today",
  this_week: "This week",
  this_month: "This month",
  last_month: "Last month",
  last_7_days: "Last 7 days",
  last_30_days: "Last 30 days",
  custom: "Custom range",
};

const CIVIL = /^\d{4}-\d{2}-\d{2}$/;

export interface DateRangeValue {
  preset: RangePreset;
  /** YYYY-MM-DD, only for "custom". */
  from?: string | null;
  to?: string | null;
}

export interface DateRangePickerProps {
  /** Org timezone — presets resolve in it (matches resolveRange on the server). */
  timeZone: string;
  /** Preset used when the URL has none (and removed from the URL when chosen). Default "this_month". */
  defaultPreset?: RangePreset;
  presets?: readonly RangePreset[];
  /** URL keys (default range / from / to). */
  keys?: { range?: string; from?: string; to?: string };
  /** Controlled mode (no URL writes): current value + change handler. */
  value?: DateRangeValue;
  onChange?: (value: DateRangeValue) => void;
  align?: "start" | "end";
  className?: string;
}

function isPreset(v: string | null | undefined): v is RangePreset {
  return !!v && (RANGE_PRESETS as readonly string[]).includes(v);
}

/**
 * Reporting range picker: today / this week / this month / last month /
 * last 7 / last 30 / custom. Writes `?range=` (+ `&from=&to=` for custom) by
 * default — the same presets `resolveRange()` understands server-side.
 */
export function DateRangePicker({
  timeZone,
  defaultPreset = "this_month",
  presets = RANGE_PRESETS,
  keys,
  value,
  onChange,
  align = "end",
  className,
}: DateRangePickerProps) {
  const url = useUrlState();
  const k = { range: keys?.range ?? "range", from: keys?.from ?? "from", to: keys?.to ?? "to" };
  const urlRange = url.get(k.range);
  const current: DateRangeValue = value ?? {
    preset: isPreset(urlRange) ? urlRange : defaultPreset,
    from: url.get(k.from),
    to: url.get(k.to),
  };
  const resolved = resolveRange(current.preset, timeZone, { from: current.from, to: current.to });

  const apply = (next: DateRangeValue) => {
    if (onChange) {
      onChange(next);
      return;
    }
    url.patch({
      [k.range]: next.preset === defaultPreset && next.preset !== "custom" ? null : next.preset,
      [k.from]: next.preset === "custom" ? next.from : null,
      [k.to]: next.preset === "custom" ? next.to : null,
    });
  };

  return (
    <Popover className={className}>
      <PopoverTrigger variant="outline" size="sm" className="gap-1.5 font-normal" aria-label={`Date range: ${resolved.label}`}>
        <CalendarRange aria-hidden="true" className="opacity-70" />
        <span className="truncate numeric">{current.preset === "custom" ? resolved.label : RANGE_PRESET_LABELS[current.preset]}</span>
        <ChevronDown aria-hidden="true" className="opacity-60" />
      </PopoverTrigger>
      <PopoverContent align={align} aria-label="Choose date range" className="w-[min(20rem,calc(100vw-2rem))] p-0">
        <RangePanel presets={presets} current={current} timeZone={timeZone} onApply={apply} />
      </PopoverContent>
    </Popover>
  );
}

function RangePanel({
  presets,
  current,
  timeZone,
  onApply,
}: {
  presets: readonly RangePreset[];
  current: DateRangeValue;
  timeZone: string;
  onApply: (v: DateRangeValue) => void;
}) {
  const { setOpen } = usePopover();
  const id = React.useId();
  const today = todayCivil(timeZone);
  const [custom, setCustom] = React.useState(current.preset === "custom");
  const [from, setFrom] = React.useState(current.from && CIVIL.test(current.from) ? current.from : addCivilDays(today, -29));
  const [to, setTo] = React.useState(current.to && CIVIL.test(current.to) ? current.to : today);
  const invalid = !CIVIL.test(from) || !CIVIL.test(to) || from > to;

  return (
    <div>
      <div role="radiogroup" aria-label="Range presets" className="p-1">
        {presets
          .filter((p) => p !== "custom")
          .map((p) => {
            const on = !custom && current.preset === p;
            return (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => {
                  onApply({ preset: p });
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between gap-3 rounded-sm px-2.5 py-1.5 text-left text-sm text-ink outline-none transition-colors hover:bg-surface-muted focus-visible:bg-surface-muted"
              >
                <span>{RANGE_PRESET_LABELS[p]}</span>
                <span className="flex items-center gap-2 text-xs text-ink-subtle numeric">
                  {resolveRange(p, timeZone).label !== RANGE_PRESET_LABELS[p] ? resolveRange(p, timeZone).label : null}
                  {on ? <Check aria-hidden="true" className="size-3.5 text-accent-ink" /> : null}
                </span>
              </button>
            );
          })}
        {presets.includes("custom") ? (
          <button
            type="button"
            role="radio"
            aria-checked={custom}
            onClick={() => setCustom(true)}
            className={cn(
              "flex w-full items-center justify-between rounded-sm px-2.5 py-1.5 text-left text-sm text-ink outline-none transition-colors hover:bg-surface-muted focus-visible:bg-surface-muted",
              custom && "bg-surface-muted",
            )}
          >
            Custom range…
            {custom && current.preset === "custom" ? <Check aria-hidden="true" className="size-3.5 text-accent-ink" /> : null}
          </button>
        ) : null}
      </div>
      {custom ? (
        <form
          className="space-y-3 border-t border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (invalid) return;
            onApply({ preset: "custom", from, to });
            setOpen(false);
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor={`${id}-from`}>From</Label>
              <DateInput id={`${id}-from`} size="sm" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-to`}>To</Label>
              <DateInput id={`${id}-to`} size="sm" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
          {invalid ? <p className="text-xs text-danger">The start date must be on or before the end date.</p> : null}
          <Button type="submit" size="sm" className="w-full" disabled={invalid}>
            Apply range
          </Button>
        </form>
      ) : null}
    </div>
  );
}
