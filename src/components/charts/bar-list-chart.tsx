"use client";

import * as React from "react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/utils";
import type { TooltipBaseProps } from "./chart-tooltip";
import { ChartTooltipBox } from "./chart-tooltip";
import { formatValue, type ValueFormat } from "./format";
import { AXIS_TICK, CHART_COLORS, chartColor, type ChartColor } from "./theme";

export interface BarListDatum {
  key: string;
  label: string;
  value: number | null;
  /** Palette key or CSS colour; defaults to the chart colour. */
  color?: ChartColor | string;
  /** Extra tooltip line ("12 stages measured"). */
  hint?: string;
}

export interface BarListChartProps {
  data: BarListDatum[];
  valueFormat?: ValueFormat;
  /** Default bar colour (accent). */
  color?: ChartColor | string;
  /** Vertical guide (e.g. 100% capacity, org average). */
  reference?: { value: number; label: string };
  /** Fixed X domain, e.g. [0, 100] for percentages. */
  domain?: [number, number | "auto"];
  /** Value axis caption. */
  valueLabel: string;
  ariaLabel: string;
  /** Width reserved for category labels (px). */
  labelWidth?: number;
  className?: string;
}

type Extra = { valueFormat: ValueFormat; valueLabel: string; data: BarListDatum[] };

function BarListTooltip({ active, payload, valueFormat, valueLabel, data }: TooltipBaseProps & Extra) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0]?.payload as BarListDatum | undefined;
  if (!d) return null;
  const match = data.find((x) => x.key === d.key);
  return (
    <ChartTooltipBox
      title={d.label}
      rows={[{ key: d.key, label: valueLabel, value: d.value, color: chartColor(match?.color), format: valueFormat }]}
      footer={d.hint}
    />
  );
}

/**
 * Horizontal bar list — comparisons across stages / people. Bars share one
 * colour unless a datum sets its own (status colours only when the bar IS a
 * status). Values are labelled at the bar end; height grows with the rows.
 */
export function BarListChart({
  data,
  valueFormat = "count",
  color = "accent",
  reference,
  domain,
  valueLabel,
  ariaLabel,
  labelWidth = 112,
  className,
}: BarListChartProps) {
  const height = Math.max(120, data.length * 34 + 32);
  const rows = data.map((d) => ({ ...d, color: d.color ?? color, plotted: d.value ?? 0 }));
  return (
    <figure aria-label={ariaLabel} className={cn("m-0 min-w-0", className)}>
      <div aria-hidden="true" style={{ height }} className="min-w-0 select-none">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 560, height }}>
          <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 56, bottom: 4, left: 0 }} barCategoryGap="28%">
            <CartesianGrid horizontal={false} stroke={CHART_COLORS.grid} />
            <XAxis
              type="number"
              dataKey="plotted"
              tickLine={false}
              axisLine={false}
              tick={AXIS_TICK}
              domain={domain ?? [0, "auto"]}
              tickFormatter={(v: number) => formatValue(v, valueFormat)}
              height={36}
              label={{ value: valueLabel, position: "insideBottom", offset: 0, fill: CHART_COLORS.axis, fontSize: 11 }}
            />
            <YAxis
              type="category"
              dataKey="label"
              tickLine={false}
              axisLine={false}
              width={labelWidth}
              tick={{ ...AXIS_TICK, fill: "var(--ink-secondary)", fontSize: 12 }}
              interval={0}
            />
            <Tooltip
              cursor={{ fill: CHART_COLORS.cursor }}
              content={(props) => <BarListTooltip active={props.active} payload={props.payload} label={props.label} valueFormat={valueFormat} valueLabel={valueLabel} data={data} />}
            />
            {reference ? (
              <ReferenceLine
                x={reference.value}
                stroke={CHART_COLORS.neutral}
                strokeDasharray="4 4"
                label={{ value: reference.label, position: "top", fill: CHART_COLORS.axis, fontSize: 11 }}
              />
            ) : null}
            <Bar dataKey="plotted" radius={[0, 3, 3, 0]} maxBarSize={18} isAnimationActive={false}>
              {rows.map((r) => (
                <Cell key={r.key} fill={chartColor(r.color)} />
              ))}
              <LabelList
                dataKey="value"
                position="right"
                offset={6}
                fill="var(--ink-secondary)"
                fontSize={11}
                formatter={(v: unknown) => formatValue(typeof v === "number" ? v : null, valueFormat)}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="sr-only">
        <table>
          <caption>{ariaLabel}</caption>
          <tbody>
            {data.map((d) => (
              <tr key={d.key}>
                <th scope="row">{d.label}</th>
                <td>{formatValue(d.value, valueFormat)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
