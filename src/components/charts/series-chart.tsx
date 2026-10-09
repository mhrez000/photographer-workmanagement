"use client";

import * as React from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/utils";
import type { TooltipBaseProps } from "./chart-tooltip";
import { ChartLegend, ChartTooltipBox, type ChartTooltipRow } from "./chart-tooltip";
import { formatCivilLabel, formatCivilTick, formatValue, type DateFormat, type ValueFormat } from "./format";
import { AXIS_TICK, CHART_COLORS, chartColor, type ChartColor } from "./theme";

export type SeriesDatum = Record<string, string | number | null>;

export interface SeriesDef {
  key: string;
  label: string;
  kind?: "line" | "area" | "bar";
  color?: ChartColor | string;
  dashed?: boolean;
  /** Overrides the chart-level valueFormat for this series (tooltip + table). */
  format?: ValueFormat;
  stackId?: string;
}

export interface SeriesChartProps {
  data: SeriesDatum[];
  series: SeriesDef[];
  /** Category / date key on each datum (default "date"). */
  xKey?: string;
  /** How x values render: civil dates ("day" / "week" / "month") or raw labels ("none"). */
  dateFormat?: DateFormat;
  valueFormat?: ValueFormat;
  /** X axis caption. */
  xLabel?: string;
  /** Y axis caption. */
  yLabel?: string;
  height?: number;
  /** Fixed Y domain, e.g. [0, 100] for percentages. */
  yDomain?: [number, number];
  /** Horizontal guide (target / average). */
  reference?: { value: number; label: string };
  /** Accessible summary of what the chart shows. */
  ariaLabel: string;
  className?: string;
}

type TooltipExtra = { series: SeriesDef[]; valueFormat: ValueFormat; dateFormat: DateFormat };

function SeriesTooltip({ active, payload, label, series, valueFormat, dateFormat }: TooltipBaseProps & TooltipExtra) {
  if (!active || !payload || payload.length === 0) return null;
  const datum = payload[0]?.payload as SeriesDatum | undefined;
  const rows: ChartTooltipRow[] = series.map((s) => {
    const raw = datum?.[s.key];
    return { key: s.key, label: s.label, value: typeof raw === "number" ? raw : null, color: chartColor(s.color), format: s.format ?? valueFormat };
  });
  return <ChartTooltipBox title={formatCivilLabel(String(label ?? ""), dateFormat)} rows={rows} />;
}

/**
 * Time-series / category chart (lines, areas or bars on one value axis).
 * One accent series plus neutral comparisons by default; hairline grid;
 * tabular ticks; custom tooltip; a visually hidden data table for screen
 * readers (the SVG itself is aria-hidden).
 */
export function SeriesChart({
  data,
  series,
  xKey = "date",
  dateFormat = "day",
  valueFormat = "count",
  xLabel,
  yLabel,
  height = 240,
  yDomain,
  reference,
  ariaLabel,
  className,
}: SeriesChartProps) {
  const dense = data.length > 16;
  return (
    <figure aria-label={ariaLabel} className={cn("m-0 flex min-w-0 flex-col gap-2", className)}>
      <ChartLegend
        items={series.map((s) => ({ key: s.key, label: s.label, color: chartColor(s.color), dashed: s.dashed, swatch: s.kind === "bar" ? "box" : "line" }))}
      />
      <div aria-hidden="true" style={{ height }} className="min-w-0 select-none">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height }}>
          <ComposedChart data={data} margin={{ top: 8, right: 20, bottom: 0, left: 0 }} barCategoryGap={dense ? "14%" : "28%"}>
            <CartesianGrid vertical={false} stroke={CHART_COLORS.grid} />
            <XAxis
              dataKey={xKey}
              tickLine={false}
              axisLine={{ stroke: CHART_COLORS.grid }}
              tick={AXIS_TICK}
              tickFormatter={(v: unknown) => formatCivilTick(String(v), dateFormat)}
              minTickGap={18}
              interval="preserveStartEnd"
              height={xLabel ? 40 : 24}
              label={xLabel ? { value: xLabel, position: "insideBottom", offset: 0, fill: CHART_COLORS.axis, fontSize: 11 } : undefined}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tick={AXIS_TICK}
              width={yLabel ? 56 : 44}
              allowDecimals={valueFormat !== "count"}
              domain={yDomain ?? [0, "auto"]}
              tickFormatter={(v: number) => formatValue(v, valueFormat)}
              label={
                yLabel
                  ? { value: yLabel, angle: -90, position: "insideLeft", offset: 12, fill: CHART_COLORS.axis, fontSize: 11, style: { textAnchor: "middle" } }
                  : undefined
              }
            />
            <Tooltip
              cursor={{ fill: CHART_COLORS.cursor, stroke: CHART_COLORS.grid }}
              content={(props) => <SeriesTooltip active={props.active} payload={props.payload} label={props.label} series={series} valueFormat={valueFormat} dateFormat={dateFormat} />}
            />
            {reference ? (
              <ReferenceLine
                y={reference.value}
                stroke={CHART_COLORS.neutral}
                strokeDasharray="4 4"
                label={{ value: reference.label, position: "insideTopRight", fill: CHART_COLORS.axis, fontSize: 11 }}
              />
            ) : null}
            {series.map((s) => {
              const color = chartColor(s.color);
              if (s.kind === "bar") {
                return (
                  <Bar
                    key={s.key}
                    dataKey={s.key}
                    name={s.label}
                    fill={color}
                    stackId={s.stackId}
                    radius={s.stackId ? 0 : [3, 3, 0, 0]}
                    maxBarSize={40}
                    isAnimationActive={false}
                  />
                );
              }
              if (s.kind === "area") {
                return (
                  <Area
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={s.label}
                    stroke={color}
                    strokeWidth={2}
                    fill={color}
                    fillOpacity={0.12}
                    stackId={s.stackId}
                    connectNulls
                    dot={false}
                    activeDot={{ r: 3.5, strokeWidth: 0 }}
                    isAnimationActive={false}
                  />
                );
              }
              return (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label}
                  stroke={color}
                  strokeWidth={s.dashed ? 1.5 : 2}
                  strokeDasharray={s.dashed ? "4 4" : undefined}
                  connectNulls
                  dot={data.length <= 12 ? { r: 2.5, strokeWidth: 0, fill: color } : false}
                  activeDot={{ r: 3.5, strokeWidth: 0 }}
                  isAnimationActive={false}
                />
              );
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">{xLabel ?? "Period"}</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((d, i) => (
            <tr key={i}>
              <th scope="row">{formatCivilLabel(String(d[xKey] ?? ""), dateFormat)}</th>
              {series.map((s) => {
                const v = d[s.key];
                return <td key={s.key}>{formatValue(typeof v === "number" ? v : null, s.format ?? valueFormat)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
