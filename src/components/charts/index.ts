/**
 * Chart primitives (recharts). Palette = CSS variables (light + dark):
 * one accent hue, neutral greys for comparisons, status / semantic colours
 * only when a series IS that status or signal. Charts are client islands;
 * pass data + format *names* from server components.
 */
export { ChartCard, ChartEmpty, type ChartCardProps } from "./chart-card";
export { SeriesChart, type SeriesChartProps, type SeriesDef, type SeriesDatum } from "./series-chart";
export { BarListChart, type BarListChartProps, type BarListDatum } from "./bar-list-chart";
export { ChartLegend, ChartTooltipBox, type ChartTooltipRow } from "./chart-tooltip";
export { formatValue, formatSecondsShort, formatCivilTick, formatCivilLabel, type ValueFormat, type DateFormat } from "./format";
export { CHART_COLORS, chartColor, statusColorVar, type ChartColor } from "./theme";
