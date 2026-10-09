"use client";

import * as React from "react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useUrlState } from "@/hooks/use-url-state";
import { cn } from "@/lib/utils";

export interface UrlSegmentedProps {
  /** URL search param this control writes. */
  param: string;
  options: { value: string; label: string }[];
  /** Value when the param is absent (written as "no param"). */
  defaultValue: string;
  "aria-label": string;
  size?: "sm" | "md";
  /** Extra params cleared on change (e.g. custom from/to when switching range). */
  clears?: string[];
  className?: string;
}

/** SegmentedControl whose value lives in the URL (shareable, survives reload). */
export function UrlSegmented({ param, options, defaultValue, size = "sm", clears = [], className, ...rest }: UrlSegmentedProps) {
  const url = useUrlState();
  const raw = url.get(param);
  const value = raw && options.some((o) => o.value === raw) ? raw : defaultValue;
  return (
    <SegmentedControl
      aria-label={rest["aria-label"]}
      size={size}
      value={value}
      options={options}
      className={cn(url.isPending && "opacity-70", className)}
      onValueChange={(next) => {
        const patch: Record<string, string | null> = { [param]: next === defaultValue ? null : next };
        for (const key of clears) patch[key] = null;
        url.patch(patch);
      }}
    />
  );
}
