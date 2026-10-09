import type { ReactNode } from "react";
import type { Metadata } from "next";
import { CalendarCheck2, CircleCheckBig, ListChecks, Settings2 } from "lucide-react";
import {
  ActivityWidget,
  BottleneckBanners,
  CalendarMini,
  CompletionRateWidget,
  DASHBOARD_ACTIVITY_EVENT_TYPES,
  DashboardBoard,
  EditorPerformanceWidget,
  JobListWidget,
  KpiStrip,
  MyPerformanceWidget,
  MyWorkloadWidget,
  RevisionRateWidget,
  WorkloadOverview,
  bucketCalendar,
} from "@/components/dashboard";
import { PageContainer } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import type { DashboardWidgetType } from "@/lib/constants";
import { addCivilDays, todayCivil } from "@/lib/dates";
import { formatNumber, pluralise } from "@/lib/utils";
import { getViewer } from "@/server/auth/session";
import { allowed, load, pageContext, param } from "@/server/page";
import { listActivity } from "@/server/queries/activity";
import { getCalendarEvents } from "@/server/queries/calendar";
import { getDashboard, queuePreview } from "@/server/queries/dashboard";
import { allowedWidgetTypes, getDashboardLayout } from "@/server/services/dashboards";

export const metadata: Metadata = { title: "Dashboard" };

function greetingAt(now: Date, timeZone: string): string {
  const hour = Number(new Intl.DateTimeFormat("en-AU", { hour: "numeric", hourCycle: "h23", timeZone }).format(now));
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function longDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone }).format(now);
}

/**
 * Dashboard (spec §3, §14, §25; ARCHITECTURE.md §10): "What is happening in my
 * business right now?" Management get org-wide KPIs, bottlenecks and the
 * editor workload overview; photographers and editors get the personal
 * variant. Every widget is laid out from the viewer's saved DashboardLayout.
 */
export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  const sp = await searchParams;
  const editing = param(sp, "customise") === "1";
  const { ctx, db } = await pageContext();
  const viewer = await getViewer();
  const tz = ctx.settings.timezone;

  const data = load(() => getDashboard(db, ctx));
  const layoutView = load(() => getDashboardLayout(db, ctx));
  const available = Array.from(allowedWidgetTypes(ctx));
  const types = new Set<DashboardWidgetType>(layoutView.layout.widgets.map((w) => w.type));
  const now = new Date(data.asOf);
  const management = data.variant === "management";
  const { kpis } = data;

  /** Server-rendered body per widget type (only for widgets on the layout; customise mode needs none). */
  const content: Partial<Record<DashboardWidgetType, ReactNode>> = {};
  if (!editing) {
    for (const type of types) {
      switch (type) {
        case "kpis":
          content.kpis = <KpiStrip kpis={kpis} rates={data.rates} />;
          break;
        case "bottlenecks":
          content.bottlenecks =
            data.bottlenecks.length > 0 ? (
              <BottleneckBanners alerts={data.bottlenecks} allHref={allowed(ctx, "bottlenecks.view") ? "/insights/bottlenecks" : null} />
            ) : null;
          break;
        case "team_workload":
          content.team_workload = data.workloads ? <WorkloadOverview rows={data.workloads} showAllLink={allowed(ctx, "workloads.view_team")} /> : null;
          break;
        case "due_today":
          content.due_today = (
            <JobListWidget
              title="Due today"
              jobs={data.dueToday}
              total={kpis.dueToday}
              timeZone={tz}
              tone="attention"
              viewAllHref="/workspace/all?quick=due_today"
              empty={{ icon: CalendarCheck2, title: "Nothing due today", description: "No editing deadlines fall later today." }}
            />
          );
          break;
        case "overdue":
          content.overdue = (
            <JobListWidget
              title="Overdue"
              jobs={data.overdue}
              total={kpis.overdue}
              timeZone={tz}
              tone="danger"
              viewAllHref="/workspace/all?quick=overdue"
              empty={{ icon: CircleCheckBig, title: "Nothing overdue", description: "Every active job is on schedule." }}
            />
          );
          break;
        case "recent_activity": {
          const feed = listActivity(db, ctx, { eventType: [...DASHBOARD_ACTIVITY_EVENT_TYPES], limit: 8 }).items;
          content.recent_activity = <ActivityWidget items={feed} timeZone={tz} />;
          break;
        }
        case "recent_completed":
          content.recent_completed = (
            <JobListWidget
              title="Recently completed"
              description={`${pluralise(kpis.completedThisWeek, "job")} completed this week`}
              jobs={data.recentCompleted}
              timeZone={tz}
              variant="completed"
              showCount={false}
              max={6}
              viewAllHref="/workspace/all?quick=completed"
              viewAllLabel="View finished work"
              empty={{ icon: CircleCheckBig, title: "No completed jobs yet", description: "Finished jobs and their delivery links will appear here." }}
            />
          );
          break;
        case "editor_performance":
          content.editor_performance = data.editorPerformance ? <EditorPerformanceWidget rows={data.editorPerformance} /> : null;
          break;
        case "completion_rate":
          content.completion_rate = <CompletionRateWidget rates={data.rates} />;
          break;
        case "revision_rate":
          content.revision_rate = <RevisionRateWidget rates={data.rates} />;
          break;
        case "my_workload":
          content.my_workload = (
            <MyWorkloadWidget
              workload={data.personal?.myWorkload ?? null}
              kpis={kpis}
              queue={data.personal?.queuePreview ?? queuePreview(db, ctx)}
              timeZone={tz}
              role={ctx.role}
            />
          );
          break;
        case "my_performance":
          content.my_performance = (
            <MyPerformanceWidget
              editor={data.personal?.myPerformance ?? null}
              photographer={data.personal?.myPhotographerPerformance ?? null}
              href={ctx.userId ? `/team/users/${ctx.userId}` : null}
            />
          );
          break;
        case "calendar": {
          const today = todayCivil(tz, now);
          const events = getCalendarEvents(db, ctx, { from: today, to: addCivilDays(today, 6), kinds: ["shoot", "due"] });
          content.calendar = <CalendarMini days={bucketCalendar(events, tz, now)} />;
          break;
        }
      }
    }
  }

  const firstName = viewer?.name.split(" ")[0] ?? "there";
  const summary = management
    ? [
        pluralise(kpis.active, "active job"),
        kpis.overdue ? `${formatNumber(kpis.overdue)} overdue` : "nothing overdue",
        `${formatNumber(kpis.dueToday)} due today`,
        data.workloads ? pluralise(data.workloads.filter((w) => w.editor.isActive).length, "editor") : null,
      ]
    : [
        ctx.role === "editor" && data.personal?.myWorkload
          ? `${pluralise(data.personal.myWorkload.active, "job")} on your plate`
          : pluralise(kpis.active, "active job"),
        kpis.overdue ? `${formatNumber(kpis.overdue)} overdue` : "nothing overdue",
        `${formatNumber(kpis.dueToday)} due today`,
      ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow={longDate(now, tz)}
        title={editing ? "Customise dashboard" : `${greetingAt(now, tz)}, ${firstName}`}
        description={editing ? "Choose what you see first when you open the studio." : summary.filter(Boolean).join(" · ")}
        actions={
          editing ? null : (
            <>
              <Button variant="outline" href="/dashboard?customise=1" leadingIcon={<Settings2 aria-hidden="true" />}>
                Customise
              </Button>
              {ctx.role === "editor" ? (
                <Button href="/workspace/my" leadingIcon={<ListChecks aria-hidden="true" />}>
                  My Work
                </Button>
              ) : null}
            </>
          )
        }
      />
      <DashboardBoard
        widgets={layoutView.layout.widgets}
        version={layoutView.version}
        isDefault={layoutView.isDefault}
        available={available}
        content={content}
        editing={editing}
        timeZone={tz}
      />
    </PageContainer>
  );
}
