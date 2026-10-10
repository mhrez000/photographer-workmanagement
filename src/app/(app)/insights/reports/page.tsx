import type { Metadata } from "next";
import Link from "next/link";
import { AlarmClock, CalendarCheck, Camera, Clock, Download, Gauge, Hourglass, Layers, RotateCcw, Send, Siren, Users } from "lucide-react";
import { ChartCard, SeriesChart } from "@/components/charts";
import { SectionCard } from "@/components/common/section-card";
import { StatTile, type StatTileProps } from "@/components/common/stat-tile";
import { DateRangePicker } from "@/components/filters";
import { PrintButton, ReportPrintStyles } from "@/components/insights/report-print";
import { ReportTable } from "@/components/insights/report-table";
import { bucketKind } from "@/components/insights/trend-utils";
import { rangeFromParams } from "@/components/insights/range-params";
import { PageContainer } from "@/components/shell";
import { ScrollFade } from "@/components/work-table/scroll-fade";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { REPORT_KINDS, type ReportKind } from "@/lib/constants";
import { formatDateTime, formatDuration } from "@/lib/dates";
import type { Report, ReportCell } from "@/lib/types";
import { cn, formatPercent } from "@/lib/utils";
import { getAnalyticsOverview } from "@/server/queries/analytics";
import { getBottlenecks } from "@/server/queries/bottlenecks";
import { getReport } from "@/server/queries/reports";
import { allowed, guard, load, pageContext, param } from "@/server/page";

export const metadata: Metadata = { title: "Reports" };

const DEFAULT_PRESET = "this_month" as const;
const PRESETS = ["today", "this_week", "this_month", "last_month", "custom"] as const;

const TABS: Record<ReportKind, { label: string; icon: typeof Layers; blurb: string; mobileKeys: string[] }> = {
  production: {
    label: "Production",
    icon: Layers,
    blurb: "Every job created, approved or completed in the range, with turnaround and on-time result.",
    mobileKeys: ["status", "turnaroundHours", "onTime"],
  },
  editors: {
    label: "Editors",
    icon: Users,
    blurb: "Completed, turnaround, revision rate and on-time % per editor (credited to the approving editor).",
    mobileKeys: ["completed", "avgTurnaroundHours", "onTimePercent"],
  },
  photographers: {
    label: "Photographers",
    icon: Camera,
    blurb: "Jobs created, submitted and completed per photographer, with how fast shoots reach review.",
    mobileKeys: ["submitted", "completed", "avgProcessingHours"],
  },
  business: {
    label: "Business",
    icon: Gauge,
    blurb: "Volume and delivery per client, plus capacity, bottlenecks and the production trend.",
    mobileKeys: ["created", "completed", "onTimePercent"],
  },
};

const num = (v: ReportCell | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const hoursLabel = (h: number | null) => (h === null ? "—" : formatDuration(h * 3_600_000));

function isKind(v: string | undefined): v is ReportKind {
  return !!v && (REPORT_KINDS as readonly string[]).includes(v);
}

export default async function ReportsPage({ searchParams }: PageProps<"/insights/reports">) {
  const sp = await searchParams;
  const { ctx, db } = await pageContext();
  guard(ctx, "reports.view");
  const tz = ctx.settings.timezone;
  const kindParam = param(sp, "kind");
  const kind: ReportKind = isKind(kindParam) ? kindParam : "production";
  const rangeInput = rangeFromParams(sp, DEFAULT_PRESET);
  const report = await load(() => getReport(db, ctx, kind, rangeInput));
  const overview = (kind === "production" || kind === "business") && allowed(ctx, "analytics.view") ? await load(() => getAnalyticsOverview(db, ctx, report.range)) : null;
  const bottlenecks = kind === "business" && allowed(ctx, "bottlenecks.view") ? await load(() => getBottlenecks(db, ctx)) : null;

  const qs = new URLSearchParams(Object.entries(rangeInput).filter((e): e is [string, string] => typeof e[1] === "string"));
  const tabHref = (k: ReportKind) => {
    const p = new URLSearchParams(qs);
    if (k !== "production") p.set("kind", k);
    if (rangeInput.range === DEFAULT_PRESET) p.delete("range");
    const s = p.toString();
    return `/insights/reports${s ? `?${s}` : ""}`;
  };
  const csvHref = `/api/reports/${kind}?${qs.toString()}&format=csv`;
  const tiles = summaryTiles(kind, report, overview, bottlenecks?.length ?? null);

  return (
    <PageContainer>
      <ReportPrintStyles />
      <PageHeader
        eyebrow="Insights"
        title="Reports"
        description={
          <>
            <span className="print:hidden">{TABS[kind].blurb}</span>
            <span className="hidden print:inline">
              {report.title} · generated {formatDateTime(report.generatedAt, tz)}
            </span>
          </>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2" data-print="hide">
            <DateRangePicker timeZone={tz} defaultPreset={DEFAULT_PRESET} presets={PRESETS} />
            {allowed(ctx, "export.csv") ? (
              <Button variant="outline" href={csvHref} prefetch={false} leadingIcon={<Download aria-hidden="true" />} download>
                Download CSV
              </Button>
            ) : null}
            <PrintButton />
          </div>
        }
      />

      {/* Scrolls sideways on a phone; the fade shows there are more tabs (icons drop below sm so all four usually fit). */}
      <ScrollFade className="-mb-2" fadeClassName="from-canvas">
        <nav aria-label="Report type" className="overflow-x-auto scrollbar-none border-b border-border" data-print="hide">
          <ul className="flex min-w-max gap-0.5 sm:gap-1">
            {REPORT_KINDS.map((k) => {
              const Icon = TABS[k].icon;
              const active = k === kind;
              return (
                <li key={k}>
                  <Link
                    href={tabHref(k)}
                    aria-current={active ? "page" : undefined}
                    scroll={false}
                    className={cn(
                      "relative inline-flex h-10 items-center gap-2 rounded-t-sm px-2.5 text-sm font-medium focus-ring-inset transition-colors duration-(--motion-fast) sm:px-3",
                      active ? "text-ink after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent" : "text-ink-muted hover:text-ink",
                    )}
                  >
                    <Icon aria-hidden="true" className={cn("hidden size-4 sm:block", active ? "text-accent" : "text-ink-subtle")} />
                    {TABS[k].label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </ScrollFade>

      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <StatTile key={String(t.label)} {...t} />
        ))}
      </section>

      {kind === "business" && overview && overview.trend.length > 1 ? (
        <ChartCard
          title="Production trend"
          takeaway={(() => {
            const c = overview.trend.reduce((s, p) => s + p.created, 0);
            const d = overview.trend.reduce((s, p) => s + p.completed, 0);
            return `${c} jobs in, ${d} completed — ${c > d ? `backlog up ${c - d}` : c < d ? `backlog down ${d - c}` : "backlog flat"} over ${report.range.label.toLowerCase()}.`;
          })()}
          data-print="flat"
        >
          <SeriesChart
            data={overview.trend.map((p) => ({ date: p.date, created: p.created, completed: p.completed }))}
            series={[
              { key: "created", label: "Created", kind: "bar", color: "neutralSoft" },
              { key: "completed", label: "Completed", kind: "bar", color: "accent" },
            ]}
            dateFormat={bucketKind(overview.trend)}
            yLabel="Jobs"
            height={220}
            ariaLabel="Jobs created and completed over the range"
          />
        </ChartCard>
      ) : null}

      <SectionCard
        title={report.title}
        description={`${report.rows.length} row${report.rows.length === 1 ? "" : "s"} · generated ${formatDateTime(report.generatedAt, tz)}`}
        flush
        data-print="flat"
      >
        <ReportTable
          columns={report.columns}
          rows={report.rows}
          totals={report.totals}
          timeZone={tz}
          mobileKeys={TABS[kind].mobileKeys}
          leadKeys={TABS[kind].mobileKeys}
          emptyTitle="Nothing in this range"
          emptyDescription="No jobs were created, approved or completed between these dates. Try a wider range."
        />
      </SectionCard>
    </PageContainer>
  );
}

type Tile = Pick<StatTileProps, "label" | "value" | "sub" | "tone" | "icon" | "href">;

function summaryTiles(kind: ReportKind, report: Report, overview: Awaited<ReturnType<typeof getAnalyticsOverview>> | null, bottlenecks: number | null): Tile[] {
  const t = report.totals ?? {};
  const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v)}%`);
  const onTimeTone = (v: number | null): Tile["tone"] => (v === null ? "default" : v >= 85 ? "success" : v < 70 ? "attention" : "default");
  switch (kind) {
    case "production": {
      const completed = report.rows.filter((r) => typeof r.completedAt === "string" && r.completedAt >= report.range.from && r.completedAt < report.range.to).length;
      return [
        { label: "Completed", value: overview?.completed ?? completed, sub: `${report.rows.length} jobs touched in range`, icon: CalendarCheck },
        { label: "Outstanding", value: overview?.outstanding ?? "—", sub: "Open right now", icon: Layers, href: "/workspace/all" },
        { label: "Overdue", value: overview?.overdue ?? "—", tone: (overview?.overdue ?? 0) > 0 ? "danger" : "success", sub: "Right now", icon: AlarmClock, href: "/workspace/all?quick=overdue" },
        { label: "Avg turnaround", value: hoursLabel(num(t.turnaroundHours)), sub: `${pct(num(t.onTime))} on time`, icon: Hourglass },
      ];
    }
    case "editors":
      return [
        { label: "Completed", value: num(t.completed) ?? 0, sub: `${num(t.approved) ?? 0} approved`, icon: CalendarCheck },
        { label: "Avg turnaround", value: hoursLabel(weighted(report, "avgTurnaroundHours", "approved")), sub: "Assigned → approved", icon: Hourglass },
        {
          label: "Revision rate",
          value: pct(weighted(report, "revisionRate", "approved")),
          tone: (weighted(report, "revisionRate", "approved") ?? 0) > 40 ? "attention" : "default",
          sub: "Approved jobs needing a revision",
          icon: RotateCcw,
        },
        { label: "On time", value: pct(weighted(report, "onTimePercent", "approved")), tone: onTimeTone(weighted(report, "onTimePercent", "approved")), sub: "Approved by the due date", icon: Clock },
      ];
    case "photographers":
      return [
        { label: "Submitted", value: num(t.submitted) ?? 0, sub: `${num(t.created) ?? 0} created`, icon: Send },
        { label: "Completed", value: num(t.completed) ?? 0, icon: CalendarCheck },
        { label: "Shoot → submitted", value: hoursLabel(weighted(report, "avgProcessingHours", "submitted")), sub: "Average processing time", icon: Hourglass },
        { label: "Overdue now", value: num(t.overdue) ?? 0, tone: (num(t.overdue) ?? 0) > 0 ? "danger" : "success", icon: AlarmClock },
      ];
    case "business": {
      const util = overview && overview.capacityHours > 0 ? overview.loadHours / overview.capacityHours : null;
      return [
        { label: "Volume", value: num(t.created) ?? 0, sub: `${num(t.completed) ?? 0} completed`, icon: Layers },
        { label: "On time", value: pct(num(t.onTimePercent)), tone: onTimeTone(num(t.onTimePercent)), sub: `${hoursLabel(num(t.avgTurnaroundHours))} avg turnaround`, icon: Clock },
        {
          label: "Capacity used",
          value: util === null ? "—" : formatPercent(util),
          tone: util === null ? "default" : util >= 1 ? "danger" : util >= 0.7 ? "attention" : "accent",
          sub: overview ? `${overview.loadHours.toFixed(0)}h of ${overview.capacityHours.toFixed(0)}h / week` : undefined,
          icon: Gauge,
        },
        {
          label: "Bottlenecks",
          value: bottlenecks ?? "—",
          tone: bottlenecks ? "danger" : "success",
          sub: bottlenecks ? "Active right now" : "All clear",
          icon: Siren,
          href: "/insights/bottlenecks",
        },
      ];
    }
  }
}

/** Mean of a per-row metric weighted by a count column (rows without the metric are skipped). */
function weighted(report: Report, key: string, weightKey: string): number | null {
  let sum = 0;
  let n = 0;
  for (const r of report.rows) {
    const v = num(r[key]);
    const w = num(r[weightKey]) ?? 0;
    if (v === null || w <= 0) continue;
    sum += v * w;
    n += w;
  }
  return n > 0 ? sum / n : null;
}
