import type { Metadata } from "next";
import { AlarmClock, CalendarCheck, CheckCheck, Clock, Gauge, Hourglass, Layers, RotateCcw } from "lucide-react";
import { BarListChart, ChartCard, SeriesChart, statusColorVar, type BarListDatum } from "@/components/charts";
import { SectionCard } from "@/components/common/section-card";
import { StatTile } from "@/components/common/stat-tile";
import { DateRangePicker } from "@/components/filters";
import { rateSeries, bucketKind } from "@/components/insights/trend-utils";
import { rangeFromParams } from "@/components/insights/range-params";
import { PageContainer } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { STATUS_CATEGORIES, STATUS_CATEGORY_META } from "@/lib/constants";
import { formatDuration } from "@/lib/dates";
import { formatPercent, pluralise } from "@/lib/utils";
import { getAnalyticsOverview } from "@/server/queries/analytics";
import { getReport } from "@/server/queries/reports";
import { canViewTeamWorkloads, getWorkloads } from "@/server/queries/workloads";
import { advancedPageContext, allowed, guard, load } from "@/server/page";

export const metadata: Metadata = { title: "Analytics" };

const DEFAULT_PRESET = "last_30_days" as const;

const TURNAROUND_BUCKETS: { label: string; max: number }[] = [
  { label: "< 1 day", max: 24 },
  { label: "1–2 days", max: 48 },
  { label: "2–3 days", max: 72 },
  { label: "3–5 days", max: 120 },
  { label: "5–7 days", max: 168 },
  { label: "1–2 weeks", max: 336 },
  { label: "2+ weeks", max: Infinity },
];

const dur = (s: number | null) => (s === null ? "—" : formatDuration(s * 1000));

export default async function AnalyticsPage({ searchParams }: PageProps<"/insights/analytics">) {
  const sp = await searchParams;
  const { ctx, db } = await advancedPageContext("analytics", "/editors"); // Advanced gate before any query (see src/server/page.ts)
  guard(ctx, "analytics.view");
  const rangeInput = rangeFromParams(sp, DEFAULT_PRESET);
  const o = await load(() => getAnalyticsOverview(db, ctx, rangeInput));
  const tz = ctx.settings.timezone;

  /* ---------- volume ---------- */
  const kind = bucketKind(o.trend);
  const created = o.trend.reduce((s, p) => s + p.created, 0);
  const completedSum = o.trend.reduce((s, p) => s + p.completed, 0);
  const net = created - completedSum;

  /* ---------- rates ---------- */
  const rates = rateSeries(o.trend);
  const ratePoints = rates.points.filter((p) => p.approved > 0);
  const onTimeVals = ratePoints.map((p) => p.onTimePercent).filter((v): v is number => v !== null);
  const revVals = ratePoints.map((p) => p.revisionRate).filter((v): v is number => v !== null);
  const trendWord = (vals: number[], higherIsBetter: boolean) => {
    if (vals.length < 2) return null;
    const half = Math.floor(vals.length / 2);
    const a = vals.slice(0, half).reduce((s, v) => s + v, 0) / half;
    const b = vals.slice(half).reduce((s, v) => s + v, 0) / (vals.length - half);
    const delta = b - a;
    if (Math.abs(delta) < (higherIsBetter ? 5 : 0.05)) return "holding steady";
    return (delta > 0) === higherIsBetter ? "improving" : "slipping";
  };

  /* ---------- stages ---------- */
  const stageData: BarListDatum[] = (o.stageAverages ?? [])
    .filter((s) => STATUS_CATEGORY_META[s.category].open && s.avgSeconds > 0)
    .sort((a, b) => STATUS_CATEGORIES.indexOf(a.category) - STATUS_CATEGORIES.indexOf(b.category))
    .map((s) => ({ key: s.category, label: STATUS_CATEGORY_META[s.category].label, value: s.avgSeconds, color: statusColorVar(s.category), hint: `${pluralise(s.count, "stage")} measured` }));
  const slowestStage = stageData.reduce<BarListDatum | null>((m, d) => (m === null || (d.value ?? 0) > (m.value ?? 0) ? d : m), null);

  /* ---------- turnaround distribution ---------- */
  const production = allowed(ctx, "reports.view") ? await load(() => getReport(db, ctx, "production", o.range)) : null;
  const turnarounds = (production?.rows ?? [])
    .filter((r) => typeof r.approvedAt === "string" && r.approvedAt >= o.range.from && r.approvedAt < o.range.to && typeof r.turnaroundHours === "number")
    .map((r) => r.turnaroundHours as number);
  const histogram = TURNAROUND_BUCKETS.map((b, i) => ({
    label: b.label,
    jobs: turnarounds.filter((h) => h < b.max && h >= (i === 0 ? -Infinity : TURNAROUND_BUCKETS[i - 1].max)).length,
  }));
  const sortedTa = [...turnarounds].sort((a, b) => a - b);
  const median = sortedTa.length ? sortedTa[Math.floor(sortedTa.length / 2)] : null;
  const p90 = sortedTa.length ? sortedTa[Math.min(sortedTa.length - 1, Math.floor(sortedTa.length * 0.9))] : null;

  /* ---------- per editor ---------- */
  const editors = (o.editors ?? []).filter((e) => e.user.isActive && e.approved > 0);
  const editorTurnaround: BarListDatum[] = editors
    .filter((e) => e.avgTurnaroundSeconds !== null)
    .sort((a, b) => (a.avgTurnaroundSeconds ?? 0) - (b.avgTurnaroundSeconds ?? 0))
    .map((e) => ({
      key: e.user.id,
      label: e.user.name,
      value: e.avgTurnaroundSeconds,
      hint: `${e.approved} approved · ${e.onTimePercent === null ? "—" : Math.round(e.onTimePercent) + "%"} on time · ${e.revisionRate === null ? "—" : Math.round(e.revisionRate * 100) + "%"} revisions`,
    }));
  const teamTa = o.avgTurnaroundSeconds;
  const slowerThanTeam = teamTa === null ? 0 : editorTurnaround.filter((d) => (d.value ?? 0) > teamTa * 1.25).length;

  /* ---------- capacity ---------- */
  const workloads = canViewTeamWorkloads(ctx) ? (await load(() => getWorkloads(db, ctx))).filter((w) => w.editor.isActive) : [];
  const utilisation = o.capacityHours > 0 ? o.loadHours / o.capacityHours : null;
  const capacityData: BarListDatum[] = workloads
    .sort((a, b) => b.ratio - a.ratio)
    .map((w) => ({
      key: w.editor.id,
      label: w.editor.name,
      value: Math.round(w.ratio * 100),
      color: w.band === "overloaded" ? "danger" : w.band === "near_capacity" ? "attention" : "accent",
      hint: `${w.score.toFixed(1)}h of ${w.editor.capacityHoursPerWeek}h · ${pluralise(w.active, "active job")}`,
    }));
  const over = workloads.filter((w) => w.band === "overloaded").length;
  const room = workloads.filter((w) => w.ratio < 0.5).length;

  const hasActivity = created + completedSum > 0 || o.outstanding > 0;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Insights"
        title="Analytics"
        description={`How production is flowing — ${o.range.label.toLowerCase()}. Every chart says what it means underneath its title.`}
        actions={<DateRangePicker timeZone={tz} defaultPreset={DEFAULT_PRESET} />}
      />

      <section aria-label="Summary" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Completed" value={o.completed} sub={`${created} created in range`} icon={CalendarCheck} />
        <StatTile label="Outstanding" value={o.outstanding} sub="Open right now" icon={Layers} href="/workspace/all" />
        <StatTile label="Overdue" value={o.overdue} tone={o.overdue > 0 ? "danger" : "success"} sub={o.overdue > 0 ? "Past the editing deadline" : "Nothing overdue"} icon={AlarmClock} href="/workspace/all?quick=overdue" />
        <StatTile label="Avg turnaround" value={dur(o.avgTurnaroundSeconds)} sub={median !== null ? `Median ${formatDuration(median * 3_600_000)}` : "Assigned → approved"} icon={Hourglass} />
        <StatTile
          label="On time"
          value={o.onTimePercent === null ? "—" : `${Math.round(o.onTimePercent)}%`}
          tone={o.onTimePercent === null ? "default" : o.onTimePercent >= 85 ? "success" : o.onTimePercent < 70 ? "attention" : "default"}
          sub="Approved by the due date"
          icon={Clock}
        />
        <StatTile
          label="Revision rate"
          value={o.revisionRate === null ? "—" : formatPercent(o.revisionRate)}
          tone={o.revisionRate !== null && o.revisionRate > 0.4 ? "attention" : "default"}
          sub="Approved jobs needing ≥ 1 revision"
          icon={RotateCcw}
        />
        <StatTile label="Completion rate" value={o.completionRate === null ? "—" : formatPercent(o.completionRate)} sub="Of jobs created in range, now done" icon={CheckCheck} />
        <StatTile
          label="Capacity used"
          value={utilisation === null ? "—" : formatPercent(utilisation)}
          tone={utilisation === null ? "default" : utilisation >= 1 ? "danger" : utilisation >= 0.7 ? "attention" : "accent"}
          sub={`${o.loadHours.toFixed(0)}h of ${o.capacityHours.toFixed(0)}h / week`}
          icon={Gauge}
          href={canViewTeamWorkloads(ctx) ? "/team/workloads" : undefined}
        />
      </section>

      {!hasActivity ? (
        <EmptyState
          icon={CalendarCheck}
          title="No production activity in this range"
          description="Nothing was created, approved or completed between these dates. Try a longer range."
          action={<Button href="/insights/analytics?range=last_month" variant="outline">Show last month</Button>}
          bordered
        />
      ) : (
        <>
          <ChartCard
            title="Production volume"
            takeaway={
              net > 0
                ? `${created} jobs came in and ${completedSum} were completed — the backlog grew by ${net}.`
                : net < 0
                  ? `${completedSum} completed against ${created} new — the backlog shrank by ${-net}.`
                  : `${created} in, ${completedSum} out — the backlog held steady.`
            }
          >
            <SeriesChart
              data={o.trend.map((p) => ({ date: p.date, created: p.created, completed: p.completed }))}
              series={[
                { key: "created", label: "Created", kind: kind === "week" ? "bar" : "line", color: kind === "week" ? "neutralSoft" : "neutral" },
                { key: "completed", label: "Completed", kind: kind === "week" ? "bar" : "line", color: "accent" },
              ]}
              dateFormat={kind}
              yLabel="Jobs"
              height={260}
              ariaLabel={`Jobs created and completed per ${kind}`}
            />
          </ChartCard>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <ChartCard
              title="On-time delivery"
              takeaway={
                onTimeVals.length === 0
                  ? "No approvals with a due date in this range."
                  : `${o.onTimePercent === null ? "—" : Math.round(o.onTimePercent) + "%"} of approvals met their due date${trendWord(onTimeVals, true) ? ` — ${trendWord(onTimeVals, true)}` : ""}.`
              }
              empty={onTimeVals.length === 0}
            >
              <SeriesChart
                data={rates.points.map((p) => ({ date: p.date, onTime: p.onTimePercent }))}
                series={[{ key: "onTime", label: "On time", kind: "line", color: "accent", format: "percent" }]}
                dateFormat={rates.kind}
                valueFormat="percent"
                yDomain={[0, 100]}
                yLabel="% on time"
                reference={o.onTimePercent === null ? undefined : { value: Math.round(o.onTimePercent), label: "Range avg" }}
                ariaLabel={`Share of approvals that met the due date per ${rates.kind}`}
              />
            </ChartCard>
            <ChartCard
              title="Revision rate"
              takeaway={
                revVals.length === 0
                  ? "No approvals in this range."
                  : `${o.revisionRate === null ? "—" : formatPercent(o.revisionRate)} of approved jobs needed a revision${trendWord(revVals, false) ? ` — ${trendWord(revVals, false)}` : ""}.`
              }
              empty={revVals.length === 0}
            >
              <SeriesChart
                data={rates.points.map((p) => ({ date: p.date, rate: p.revisionRate }))}
                series={[{ key: "rate", label: "Revision rate", kind: "line", color: "accent", format: "ratio" }]}
                dateFormat={rates.kind}
                valueFormat="ratio"
                yDomain={[0, 1]}
                yLabel="% needing revision"
                reference={o.revisionRate === null ? undefined : { value: o.revisionRate, label: "Range avg" }}
                ariaLabel={`Share of approved jobs that needed a revision per ${rates.kind}`}
              />
            </ChartCard>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <ChartCard
              title="Average time per stage"
              takeaway={
                slowestStage ? `${slowestStage.label} is the slowest stage at ${dur(slowestStage.value)} on average.` : "Stage times appear once jobs move through the workflow."
              }
              empty={stageData.length === 0}
            >
              <BarListChart data={stageData} valueFormat="duration" valueLabel="Average time in stage" ariaLabel="Average time jobs spend in each workflow stage" />
            </ChartCard>
            <ChartCard
              title="Turnaround distribution"
              takeaway={
                median === null
                  ? "No approvals in this range."
                  : `Half of jobs are approved within ${formatDuration(median * 3_600_000)}; 9 in 10 within ${formatDuration((p90 ?? 0) * 3_600_000)}.`
              }
              empty={turnarounds.length === 0}
              emptyMessage={production ? "No approvals in this range." : "Turnaround detail needs report access."}
            >
              <SeriesChart
                data={histogram}
                xKey="label"
                dateFormat="none"
                series={[{ key: "jobs", label: "Jobs approved", kind: "bar", color: "accent" }]}
                xLabel="Assigned → approved"
                yLabel="Jobs"
                ariaLabel="Number of approved jobs by turnaround time band"
              />
            </ChartCard>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <ChartCard
              title="Turnaround by editor"
              takeaway={
                editorTurnaround.length === 0
                  ? "No editor approvals in this range."
                  : `${editorTurnaround[0].label} is quickest at ${dur(editorTurnaround[0].value)}; ${slowerThanTeam || "no"} editor${slowerThanTeam === 1 ? " is" : "s are"} more than 25% slower than the team.`
              }
              empty={editorTurnaround.length === 0}
              actions={
                allowed(ctx, "performance.view") ? (
                  <Button variant="ghost" size="sm" href="/team/performance">
                    Full table
                  </Button>
                ) : null
              }
            >
              <BarListChart
                data={editorTurnaround}
                valueFormat="duration"
                valueLabel="Average assigned → approved"
                reference={teamTa === null ? undefined : { value: teamTa, label: "Team" }}
                ariaLabel="Average turnaround per editor"
              />
            </ChartCard>
            <ChartCard
              title="Capacity utilisation"
              takeaway={
                workloads.length === 0
                  ? `Team load is ${utilisation === null ? "—" : formatPercent(utilisation)} of capacity.`
                  : `${over || "No"} editor${over === 1 ? " is" : "s are"} over capacity; ${room} ha${room === 1 ? "s" : "ve"} room for more (under 50%).`
              }
              empty={workloads.length === 0}
              emptyMessage="Per-editor capacity is visible to people who can see team workloads."
            >
              <BarListChart
                data={capacityData}
                valueFormat="percent"
                valueLabel="Weighted load ÷ weekly capacity (%)"
                reference={{ value: 100, label: "Capacity" }}
                ariaLabel="Current load as a share of weekly capacity, per editor"
              />
            </ChartCard>
          </div>

          {o.byJobType.some((t) => t.created + t.completed > 0) ? (
            <SectionCard title="By job type" description="Volume and speed for each kind of work in this range." flush>
              <Table>
                <THead>
                  <tr>
                    <TH>Job type</TH>
                    <TH numeric>Created</TH>
                    <TH numeric>Completed</TH>
                    <TH numeric>Avg turnaround</TH>
                  </tr>
                </THead>
                <TBody>
                  {o.byJobType
                    .filter((t) => t.created + t.completed > 0)
                    .map((t) => (
                      <TR key={t.jobType.id}>
                        <TD>
                          <span className="inline-flex items-center gap-2">
                            <span aria-hidden="true" className="size-2 rounded-full" style={{ background: t.jobType.colour }} />
                            {t.jobType.name}
                          </span>
                        </TD>
                        <TD numeric>{t.created}</TD>
                        <TD numeric>{t.completed}</TD>
                        <TD numeric muted>
                          {dur(t.avgTurnaroundSeconds)}
                        </TD>
                      </TR>
                    ))}
                </TBody>
              </Table>
            </SectionCard>
          ) : null}
        </>
      )}
    </PageContainer>
  );
}
