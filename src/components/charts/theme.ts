import type { StatusCategory } from "@/lib/constants";

/**
 * Chart palette as CSS variables (theme-aware in light and dark): one accent
 * hue for the series that matters, neutral greys for comparison series, and
 * status / semantic colours only when the series IS that status or signal.
 */
export const CHART_COLORS = {
  accent: "var(--accent)",
  accentSoft: "var(--accent-soft)",
  neutral: "var(--ink-subtle)",
  neutralStrong: "var(--ink-muted)",
  neutralSoft: "var(--border-strong)",
  grid: "var(--border)",
  axis: "var(--ink-muted)",
  cursor: "var(--surface-muted)",
  danger: "var(--danger)",
  attention: "var(--attention)",
  success: "var(--success)",
  warning: "var(--warning)",
} as const;

export type ChartColor = keyof typeof CHART_COLORS;

/** Resolves a palette key or passes a raw CSS colour / var() through. */
export function chartColor(c: ChartColor | string | undefined, fallback: ChartColor = "accent"): string {
  if (!c) return CHART_COLORS[fallback];
  return c in CHART_COLORS ? CHART_COLORS[c as ChartColor] : c;
}

/** `var(--status-in-progress)` for a status category (series that ARE a status). */
export function statusColorVar(category: StatusCategory): string {
  return `var(--status-${category.replace(/_/g, "-")})`;
}

export const AXIS_TICK = { fill: CHART_COLORS.axis, fontSize: 11 } as const;
