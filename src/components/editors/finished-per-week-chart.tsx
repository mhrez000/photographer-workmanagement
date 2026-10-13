"use client";

import { SeriesChart } from "@/components/charts/series-chart";
import type { FinishedPerWeekPoint } from "@/lib/types";

export interface FinishedPerWeekChartProps {
  points: FinishedPerWeekPoint[];
  editorName: string;
}

/** "Finished per week" (docs/SIMPLIFICATION-PLAN.md §7): one hue, twelve weeks, nothing else. */
export function FinishedPerWeekChart({ points, editorName }: FinishedPerWeekChartProps) {
  return (
    <SeriesChart
      data={points.map((p) => ({ date: p.weekStart, finished: p.finished }))}
      series={[{ key: "finished", label: "Finished", kind: "bar", color: "accent" }]}
      xKey="date"
      dateFormat="week"
      valueFormat="count"
      height={200}
      ariaLabel={`Jobs ${editorName} finished per week over the last ${points.length} weeks`}
    />
  );
}
