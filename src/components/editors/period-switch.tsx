"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { EDITOR_PERIOD_LABELS, EDITOR_PERIODS } from "@/lib/editorMetrics";
import type { EditorPeriodKey } from "@/lib/types";

export interface PeriodSwitchProps {
  period: EditorPeriodKey;
  className?: string;
}

/** This month · Last month · Last 3 months — written to `?period=` so the server re-renders the numbers. */
export function PeriodSwitch({ period, className }: PeriodSwitchProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = React.useTransition();

  const change = (next: EditorPeriodKey) => {
    if (next === period) return;
    startTransition(() => {
      router.replace(next === "this_month" ? pathname : `${pathname}?period=${next}`, { scroll: false });
    });
  };

  return (
    <SegmentedControl<EditorPeriodKey>
      aria-label="Period"
      size="sm"
      value={period}
      onValueChange={change}
      options={EDITOR_PERIODS.map((value) => ({ value, label: EDITOR_PERIOD_LABELS[value] }))}
      className={className}
      aria-busy={pending || undefined}
    />
  );
}
