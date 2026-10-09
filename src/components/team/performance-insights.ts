import { formatDuration } from "@/lib/dates";
import type { PerformanceRow, PhotographerPerformanceRow, UserRef } from "@/lib/types";
import type { PerformanceFlag } from "./types";

/** Minimum approvals before rates mean anything (avoid 1-of-1 = 100 % "stars"). */
export const MIN_SAMPLE = 3;

export interface TeamAverages {
  approved: number;
  completed: number;
  onTimePercent: number | null;
  revisionRate: number | null;
  avgTurnaroundSeconds: number | null;
}

export interface Highlight {
  kind: "on_time" | "turnaround" | "first_pass" | "support";
  title: string;
  user: UserRef;
  detail: string;
}

/** Approval-weighted team averages (so a 1-job editor doesn't swing the mean). */
export function teamAverages(rows: readonly PerformanceRow[]): TeamAverages {
  let approved = 0;
  let onTimeW = 0;
  let onTimeN = 0;
  let revW = 0;
  let revN = 0;
  let taW = 0;
  let taN = 0;
  for (const r of rows) {
    approved += r.approved;
    if (r.onTimePercent !== null && r.approved > 0) {
      onTimeW += r.onTimePercent * r.approved;
      onTimeN += r.approved;
    }
    if (r.revisionRate !== null && r.approved > 0) {
      revW += r.revisionRate * r.approved;
      revN += r.approved;
    }
    if (r.avgTurnaroundSeconds !== null && r.approved > 0) {
      taW += r.avgTurnaroundSeconds * r.approved;
      taN += r.approved;
    }
  }
  return {
    approved,
    completed: rows.reduce((s, r) => s + r.completed, 0),
    onTimePercent: onTimeN > 0 ? onTimeW / onTimeN : null,
    revisionRate: revN > 0 ? revW / revN : null,
    avgTurnaroundSeconds: taN > 0 ? taW / taN : null,
  };
}

/**
 * Operational highlights: who is reliably on time, who turns work around
 * fastest, whose first pass sticks, and who needs support right now. Rates
 * require MIN_SAMPLE approvals in the range.
 */
export function editorInsights(rows: readonly PerformanceRow[]): { flags: Record<string, PerformanceFlag>; highlights: Highlight[]; averages: TeamAverages } {
  const averages = teamAverages(rows);
  const flags: Record<string, PerformanceFlag> = {};
  const flag = (id: string) => (flags[id] ??= { top: null, attention: [] });

  for (const r of rows) {
    if (!r.user.isActive) continue;
    // One overdue job alone is normal churn; flag a backlog or a pattern in the rates.
    const rateReasons: string[] = [];
    if (r.approved >= MIN_SAMPLE && r.onTimePercent !== null && r.onTimePercent < 70) rateReasons.push(`only ${Math.round(r.onTimePercent)}% on time`);
    if (r.approved >= MIN_SAMPLE && r.revisionRate !== null && r.revisionRate > 0.4) rateReasons.push(`${Math.round(r.revisionRate * 100)}% needed revisions`);
    if (r.overdue >= 2 || rateReasons.length > 0) {
      const overdue = r.overdue > 0 ? [`${r.overdue} job${r.overdue === 1 ? "" : "s"} overdue now`] : [];
      flag(r.user.id).attention = [...overdue, ...rateReasons];
    }
  }

  // Positive highlights only go to people with enough volume and nothing flagged.
  const measured = rows.filter((r) => r.user.isActive && r.approved >= MIN_SAMPLE && (flags[r.user.id]?.attention.length ?? 0) === 0);
  const highlights: Highlight[] = [];
  const best = <T,>(list: readonly T[], score: (t: T) => number | null, better: (a: number, b: number) => boolean): T | null => {
    let out: T | null = null;
    let outScore: number | null = null;
    for (const t of list) {
      const s = score(t);
      if (s === null) continue;
      if (outScore === null || better(s, outScore)) {
        out = t;
        outScore = s;
      }
    }
    return out;
  };

  const onTime = best(measured, (r) => (r.onTimePercent === null ? null : r.onTimePercent * 1000 + r.approved), (a, b) => a > b);
  if (onTime && onTime.onTimePercent !== null && onTime.onTimePercent >= 80) {
    highlights.push({
      kind: "on_time",
      title: "Most reliable",
      user: onTime.user,
      detail: `${Math.round(onTime.onTimePercent)}% on time across ${onTime.approved} approvals`,
    });
    flag(onTime.user.id).top = `Most reliable — ${Math.round(onTime.onTimePercent)}% on time`;
  }
  const fastest = best(measured, (r) => r.avgTurnaroundSeconds, (a, b) => a < b);
  if (fastest && fastest.avgTurnaroundSeconds !== null) {
    const vsTeam =
      averages.avgTurnaroundSeconds !== null && averages.avgTurnaroundSeconds > 0
        ? ` (team ${formatDuration(averages.avgTurnaroundSeconds * 1000)})`
        : "";
    highlights.push({
      kind: "turnaround",
      title: "Fastest turnaround",
      user: fastest.user,
      detail: `${formatDuration(fastest.avgTurnaroundSeconds * 1000)} assigned → approved${vsTeam}`,
    });
    flag(fastest.user.id).top ??= `Fastest turnaround — ${formatDuration(fastest.avgTurnaroundSeconds * 1000)}`;
  }
  const firstPass = best(measured, (r) => r.revisionRate, (a, b) => a < b);
  if (firstPass && firstPass.revisionRate !== null && (averages.revisionRate === null || firstPass.revisionRate < averages.revisionRate)) {
    highlights.push({
      kind: "first_pass",
      title: "Cleanest first pass",
      user: firstPass.user,
      detail: `${Math.round(firstPass.revisionRate * 100)}% needed a revision${averages.revisionRate !== null ? ` (team ${Math.round(averages.revisionRate * 100)}%)` : ""}`,
    });
    flag(firstPass.user.id).top ??= `Cleanest first pass — ${Math.round(firstPass.revisionRate * 100)}% revisions`;
  }

  const support = rows
    .filter((r) => (flags[r.user.id]?.attention.length ?? 0) > 0)
    .sort((a, b) => b.overdue - a.overdue || (flags[b.user.id].attention.length - flags[a.user.id].attention.length))[0];
  if (support) {
    highlights.push({ kind: "support", title: "Needs support", user: support.user, detail: capitalise(flags[support.user.id].attention.join(", ")) });
  }

  return { flags, highlights, averages };
}

/** Photographers: flag overdue backlogs and slow shoot → submitted processing (vs team median). */
export function photographerFlags(rows: readonly PhotographerPerformanceRow[]): Record<string, PerformanceFlag> {
  const flags: Record<string, PerformanceFlag> = {};
  const times = rows.map((r) => r.avgProcessingSeconds).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : null;
  for (const r of rows) {
    if (!r.user.isActive) continue;
    const reasons: string[] = [];
    if (r.overdue >= 2) reasons.push(`${r.overdue} of their jobs overdue`);
    if (median !== null && r.avgProcessingSeconds !== null && r.submitted >= MIN_SAMPLE && r.avgProcessingSeconds > median * 2) {
      reasons.push(`slow to submit (${formatDuration(r.avgProcessingSeconds * 1000)} vs team ${formatDuration(median * 1000)})`);
    }
    const quick = median !== null && r.avgProcessingSeconds !== null && r.submitted >= MIN_SAMPLE && r.avgProcessingSeconds <= median * 0.6;
    if (reasons.length > 0 || quick) flags[r.user.id] = { top: quick ? `Quick to submit — ${formatDuration((r.avgProcessingSeconds ?? 0) * 1000)} shoot → submitted` : null, attention: reasons };
  }
  return flags;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
