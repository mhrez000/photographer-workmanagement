import type { Metadata } from "next";
import { CalendarCheck, Clock, Download, RotateCcw, Timer } from "lucide-react";
import { BarListChart, ChartCard, type BarListDatum } from "@/components/charts";
import { SectionCard } from "@/components/common/section-card";
import { StatTile } from "@/components/common/stat-tile";
import { DateRangePicker } from "@/components/filters";
import { rangeFromParams } from "@/components/insights/range-params";
import { PageContainer } from "@/components/shell";
import { HighlightCards } from "@/components/team/highlight-cards";
import { editorInsights, MIN_SAMPLE, photographerFlags } from "@/components/team/performance-insights";
import { EditorPerformanceTable, PhotographerPerformanceTable } from "@/components/team/performance-tables";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { formatDuration } from "@/lib/dates";
import { pluralise } from "@/lib/utils";
import { getPerformance } from "@/server/queries/performance";
import { allowed, guard, load, pageContext } from "@/server/page";

export const metadata: Metadata = { title: "Performance" };

const DEFAULT_PRESET = "last_30_days" as const;

export default async function PerformancePage({ searchParams }: PageProps<"/team/performance">) {
  const sp = await searchParams;
  const { ctx, db } = await pageContext();
  guard(ctx, "performance.view");
  const rangeInput = rangeFromParams(sp, DEFAULT_PRESET);
  const report = load(() => getPerformance(db, ctx, rangeInput));
  const { flags, highlights, averages } = editorInsights(report.editors);
  const pFlags = photographerFlags(report.photographers);

  const activeEditors = report.editors.filter((r) => r.user.isActive);
  const onTimeData: BarListDatum[] = activeEditors
    .filter((r) => r.approved >= MIN_SAMPLE && r.onTimePercent !== null)
    .sort((a, b) => (b.onTimePercent ?? 0) - (a.onTimePercent ?? 0))
    .map((r) => ({
      key: r.user.id,
      label: r.user.name,
      value: r.onTimePercent,
      color: (r.onTimePercent ?? 0) < 70 ? "attention" : "accent",
      hint: `${r.approved} approved · ${r.revisionRate === null ? "—" : Math.round(r.revisionRate * 100) + "%"} revisions`,
    }));
  const completedData: BarListDatum[] = activeEditors
    .filter((r) => r.completed > 0)
    .sort((a, b) => b.completed - a.completed)
    .map((r) => ({
      key: r.user.id,
      label: r.user.name,
      value: r.completed,
      hint: r.avgTurnaroundSeconds === null ? undefined : `Avg turnaround ${formatDuration(r.avgTurnaroundSeconds * 1000)}`,
    }));
  const topCompleter = completedData[0];
  const share = topCompleter && averages.completed > 0 ? Math.round(((topCompleter.value ?? 0) / averages.completed) * 100) : 0;
  const csvRange = new URLSearchParams(Object.entries(rangeInput).filter((e): e is [string, string] => typeof e[1] === "string")).toString();

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Team"
        title="Performance"
        description={`Operational numbers for ${report.range.label.toLowerCase()}: who delivers on time, who turns work around, and who needs support.`}
        actions={
          <>
            <DateRangePicker timeZone={ctx.settings.timezone} defaultPreset={DEFAULT_PRESET} />
            {allowed(ctx, "export.csv") ? (
              <Button variant="outline" href={`/api/reports/editors?${csvRange}&format=csv`} prefetch={false} leadingIcon={<Download aria-hidden="true" />}>
                CSV
              </Button>
            ) : null}
          </>
        }
      />

      <section aria-label="Team totals" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Completed" value={averages.completed} sub={`${pluralise(averages.approved, "approval")} in range`} icon={CalendarCheck} />
        <StatTile
          label="On time"
          value={averages.onTimePercent === null ? "—" : `${Math.round(averages.onTimePercent)}%`}
          tone={averages.onTimePercent === null ? "default" : averages.onTimePercent >= 85 ? "success" : averages.onTimePercent < 70 ? "attention" : "default"}
          sub="Approved by the due date"
          icon={Clock}
        />
        <StatTile
          label="Revision rate"
          value={averages.revisionRate === null ? "—" : `${Math.round(averages.revisionRate * 100)}%`}
          tone={averages.revisionRate !== null && averages.revisionRate > 0.4 ? "attention" : "default"}
          sub="Approved jobs needing ≥ 1 revision"
          icon={RotateCcw}
        />
        <StatTile
          label="Avg turnaround"
          value={averages.avgTurnaroundSeconds === null ? "—" : formatDuration(averages.avgTurnaroundSeconds * 1000)}
          sub="Assigned → approved"
          icon={Timer}
        />
      </section>

      <HighlightCards highlights={highlights} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ChartCard
          title="On time by editor"
          takeaway={
            onTimeData.length === 0
              ? `Rates appear once an editor has ${MIN_SAMPLE}+ approvals in the range.`
              : `Team average ${averages.onTimePercent === null ? "—" : Math.round(averages.onTimePercent) + "%"}; ${onTimeData.filter((d) => (d.value ?? 0) < 70).length || "no"} editor${onTimeData.filter((d) => (d.value ?? 0) < 70).length === 1 ? "" : "s"} below 70%.`
          }
          empty={onTimeData.length === 0}
        >
          <BarListChart
            data={onTimeData}
            valueFormat="percent"
            domain={[0, 100]}
            valueLabel="Approved on time (%)"
            reference={averages.onTimePercent === null ? undefined : { value: Math.round(averages.onTimePercent), label: "Team" }}
            ariaLabel="Share of each editor's approved jobs that met the due date"
          />
        </ChartCard>
        <ChartCard
          title="Completed by editor"
          takeaway={topCompleter ? `${topCompleter.label} completed ${topCompleter.value} — ${share}% of the team's output.` : "No completions in this range."}
          empty={completedData.length === 0}
        >
          <BarListChart data={completedData} valueLabel="Jobs completed" ariaLabel="Jobs completed per editor in the selected range" />
        </ChartCard>
      </div>

      <SectionCard
        id="editors"
        title="Editors"
        description={`Rates use jobs approved in range (credited to the approving editor); “now” columns are live. Highlights need ${MIN_SAMPLE}+ approvals.`}
        flush
      >
        <EditorPerformanceTable rows={report.editors} flags={flags} />
      </SectionCard>

      <SectionCard id="photographers" title="Photographers" description="Jobs created, first submitted and completed in range, with how quickly shoots reach review." flush>
        <PhotographerPerformanceTable rows={report.photographers} flags={pFlags} />
      </SectionCard>
    </PageContainer>
  );
}
