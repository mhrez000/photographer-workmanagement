import { civilDiffDays } from "@/lib/dates";
import type { TrendPoint } from "@/lib/types";

/** "day" when buckets are 1 day apart, else "week" (analytics trends switch at 31 days). */
export function bucketKind(trend: readonly TrendPoint[]): "day" | "week" {
  if (trend.length < 2) return "day";
  return civilDiffDays(trend[0].date, trend[1].date) >= 7 ? "week" : "day";
}

export interface RatePoint {
  date: string;
  approved: number;
  onTimePercent: number | null;
  revisionRate: number | null;
  avgTurnaroundSeconds: number | null;
  revisionsRequested: number;
}

/**
 * Rate series need a few approvals per point to be readable, so daily
 * buckets are rolled up into 7-day buckets (approval-weighted) when the
 * range is longer than two weeks. Weekly trends pass through unchanged.
 */
export function rateSeries(trend: readonly TrendPoint[]): { points: RatePoint[]; kind: "day" | "week" } {
  const kind = bucketKind(trend);
  const toPoint = (p: TrendPoint): RatePoint => ({
    date: p.date,
    approved: p.approved ?? 0,
    onTimePercent: p.onTimePercent ?? null,
    revisionRate: p.revisionRate ?? null,
    avgTurnaroundSeconds: p.avgTurnaroundSeconds,
    revisionsRequested: p.revisionsRequested,
  });
  if (kind === "week" || trend.length <= 14) return { points: trend.map(toPoint), kind };

  const out: RatePoint[] = [];
  for (let i = 0; i < trend.length; i += 7) {
    const chunk = trend.slice(i, i + 7);
    const approved = chunk.reduce((s, p) => s + (p.approved ?? 0), 0);
    const weighted = (pick: (p: TrendPoint) => number | null | undefined) => {
      let sum = 0;
      let n = 0;
      for (const p of chunk) {
        const v = pick(p);
        const w = p.approved ?? 0;
        if (v === null || v === undefined || w === 0) continue;
        sum += v * w;
        n += w;
      }
      return n > 0 ? sum / n : null;
    };
    out.push({
      date: chunk[0].date,
      approved,
      onTimePercent: weighted((p) => p.onTimePercent),
      revisionRate: weighted((p) => p.revisionRate),
      avgTurnaroundSeconds: weighted((p) => p.avgTurnaroundSeconds),
      revisionsRequested: chunk.reduce((s, p) => s + p.revisionsRequested, 0),
    });
  }
  return { points: out, kind: "week" };
}
