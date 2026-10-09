import * as React from "react";
import { BarListChart, ChartCard, SeriesChart, statusColorVar, type BarListDatum } from "@/components/charts";
import { formatSecondsShort } from "@/components/charts/format";
import { STATUS_CATEGORIES, STATUS_CATEGORY_META, type StatusCategory } from "@/lib/constants";
import type { UserCompletedWork, WorkloadHistoryPoint } from "@/lib/types";

/** "Average time in each stage" — bars ARE statuses, so they take the status colour. */
export function StageTimeChart({ secondsPerCategory, className }: { secondsPerCategory: Partial<Record<StatusCategory, number>>; className?: string }) {
  const data: BarListDatum[] = STATUS_CATEGORIES.filter((c) => STATUS_CATEGORY_META[c].open && (secondsPerCategory[c] ?? 0) > 0).map((c) => ({
    key: c,
    label: STATUS_CATEGORY_META[c].label,
    value: secondsPerCategory[c] ?? 0,
    color: statusColorVar(c),
  }));
  const slowest = data.reduce<BarListDatum | null>((m, d) => (m === null || (d.value ?? 0) > (m.value ?? 0) ? d : m), null);
  return (
    <ChartCard
      className={className}
      title="Average time in each stage"
      takeaway={
        slowest
          ? `Jobs spend longest in ${slowest.label.toLowerCase()} — ${formatSecondsShort(slowest.value)} on average (last 90 days).`
          : "Stage times appear once jobs move through the workflow."
      }
      empty={data.length === 0}
      emptyMessage="No finished stages in the last 90 days."
    >
      <BarListChart data={data} valueFormat="duration" valueLabel="Average time in stage" ariaLabel="Average time spent in each workflow stage over the last 90 days" />
    </ChartCard>
  );
}

/** Held jobs per day for the last 30 days, with the org's max-active cap as a guide. */
export function WorkloadHistoryChart({ history, maxActive, className }: { history: WorkloadHistoryPoint[]; maxActive: number; className?: string }) {
  const counts = history.map((h) => h.count);
  const peak = counts.length ? Math.max(...counts) : 0;
  const current = counts.at(-1) ?? 0;
  const avg = counts.length ? counts.reduce((s, n) => s + n, 0) / counts.length : 0;
  const trend = current > avg * 1.15 ? "above" : current < avg * 0.85 ? "below" : "in line with";
  return (
    <ChartCard
      className={className}
      title="Workload — last 30 days"
      takeaway={
        peak === 0
          ? "No editor-held jobs in the last 30 days."
          : `Holding ${current} job${current === 1 ? "" : "s"} today, ${trend} the 30-day average of ${avg.toFixed(1)} (peak ${peak}).`
      }
      empty={history.length === 0 || peak === 0}
      emptyMessage="Nothing was assigned in the last 30 days."
    >
      <SeriesChart
        data={history.map((h) => ({ date: h.date, count: h.count }))}
        series={[{ key: "count", label: "Jobs held", kind: "area", color: "accent" }]}
        dateFormat="day"
        yLabel="Jobs"
        reference={peak >= maxActive * 0.6 ? { value: maxActive, label: `Max active (${maxActive})` } : undefined}
        height={220}
        ariaLabel="Jobs held per day over the last 30 days"
      />
    </ChartCard>
  );
}

/** Completions per week, split by on time / late / no due date. */
export function WeeklyCompletedChart({ weekly, className }: { weekly: UserCompletedWork["weekly"]; className?: string }) {
  const total = weekly.reduce((s, w) => s + w.completed, 0);
  const onTime = weekly.reduce((s, w) => s + w.onTime, 0);
  const late = weekly.reduce((s, w) => s + w.late, 0);
  const measured = onTime + late;
  return (
    <ChartCard
      className={className}
      title="Completed per week"
      takeaway={
        total === 0
          ? "No completions in the last 8 weeks."
          : `${total} completed in 8 weeks${measured > 0 ? ` — ${Math.round((onTime / measured) * 100)}% of those with a due date were on time` : ""}.`
      }
      empty={total === 0}
      emptyMessage="Nothing completed in the last 8 weeks."
    >
      <SeriesChart
        data={weekly.map((w) => ({ date: w.week, onTime: w.onTime, late: w.late, noDue: Math.max(0, w.completed - w.onTime - w.late) }))}
        series={[
          { key: "onTime", label: "On time", kind: "bar", color: "accent", stackId: "w" },
          { key: "late", label: "Late", kind: "bar", color: "danger", stackId: "w" },
          { key: "noDue", label: "No due date", kind: "bar", color: "neutralSoft", stackId: "w" },
        ]}
        dateFormat="week"
        yLabel="Jobs"
        height={220}
        ariaLabel="Jobs completed per week over the last 8 weeks, split by on time and late"
      />
    </ChartCard>
  );
}
