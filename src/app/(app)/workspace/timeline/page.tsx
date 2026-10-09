import type { Metadata } from "next";
import { AlertTriangle, ChartNoAxesGantt, Diamond } from "lucide-react";
import { FilterBar, type FilterFacet } from "@/components/filters/filter-bar";
import { PageContainer } from "@/components/shell";
import { TimelineGantt } from "@/components/timeline/timeline-gantt";
import { TimelineToolbar } from "@/components/timeline/timeline-toolbar";
import {
  TIMELINE_STAGES,
  defaultWindowStart,
  normaliseGroup,
  normaliseWindow,
  shiftCivil,
  type TimelineGroup,
} from "@/components/timeline/timeline-utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { endOfCivilDayIso, formatDate, startOfCivilDayIso, todayCivil } from "@/lib/dates";
import type { TimelineRow } from "@/lib/types";
import { load, pageContext, param, params } from "@/server/page";
import { loadOrgSettingsRow } from "@/server/queries/scope";
import { getTimelineRows, orgCategoryAverages, TIMELINE_BOTTLENECK_FACTOR } from "@/server/queries/timeline";

export const metadata: Metadata = { title: "Timeline" };

const CIVIL = /^\d{4}-\d{2}-\d{2}$/;
type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * /workspace/timeline — Gantt of job stages (spec §11, ARCHITECTURE §10).
 * Scope (page map): owners/managers see every visible job; photographers
 * their own jobs; editors the jobs they hold or held a stage of. Rows are
 * already restricted by `visibleJobsWhere` in the query; this page narrows
 * them further per role.
 */
export default async function TimelinePage({ searchParams }: PageProps<"/workspace/timeline">) {
  const sp = await searchParams;
  const { ctx, db } = await pageContext();
  const timeZone = ctx.settings.timezone;
  const today = todayCivil(timeZone);
  const isManagement = ctx.role === "owner" || ctx.role === "manager";

  const weeks = normaliseWindow(param(sp, "weeks"));
  const rawWeekStart = load(() => loadOrgSettingsRow(db, ctx))?.weekStartsOn ?? 1;
  const weekStartsOn = (rawWeekStart >= 0 && rawWeekStart <= 6 ? rawWeekStart : 1) as WeekStart;
  const defaultFrom = defaultWindowStart(today, weeks, weekStartsOn);
  const fromParam = param(sp, "from");
  const from = fromParam && CIVIL.test(fromParam) && !Number.isNaN(Date.parse(fromParam)) ? fromParam : defaultFrom;
  const to = shiftCivil(from, weeks * 7 - 1);

  const groupModes: readonly TimelineGroup[] = isManagement
    ? ["editor", "photographer", "project", "job"]
    : ctx.role === "photographer"
      ? ["editor", "project", "job"]
      : ["project", "job"];
  const requested = normaliseGroup(param(sp, "group") ?? (ctx.role === "editor" ? "project" : undefined));
  const group = groupModes.includes(requested) ? requested : groupModes[0];

  const all = load(() => getTimelineRows(db, ctx, { from, to, groupBy: group === "photographer" ? "photographer" : "editor" }));
  const averages = load(() => orgCategoryAverages(db, ctx));

  // Role scope (page map: "managers; P own; E assigned").
  const me = ctx.userId;
  const scoped: TimelineRow[] = isManagement
    ? all
    : ctx.role === "photographer"
      ? all.filter((r) => r.job.photographer?.id === me)
      : all.filter((r) => r.job.editor?.id === me || r.segments.some((s) => s.editor?.id === me));

  // Filters from the FilterBar (URL state).
  const q = (param(sp, "q") ?? "").trim().toLowerCase();
  const editorIds = params(sp, "editorId");
  const photographerIds = params(sp, "photographerId");
  const priorities = params(sp, "priority");
  const matches = (ids: string[], id: string | undefined) => ids.length === 0 || ids.includes(id ?? "none");
  const rows = scoped.filter(
    (r) =>
      matches(editorIds, r.job.editor?.id) &&
      matches(photographerIds, r.job.photographer?.id) &&
      (priorities.length === 0 || priorities.includes(r.job.priority)) &&
      (!q || [r.job.jobNumber, r.job.name, r.job.client?.name ?? "", r.job.project?.name ?? ""].some((s) => s.toLowerCase().includes(q))),
  );
  const filtered = Boolean(q) || editorIds.length + photographerIds.length + priorities.length > 0;

  const days: string[] = [];
  for (let d = from; d <= to; d = shiftCivil(d, 1)) days.push(d);
  const dayStarts = [...days.map((d) => Date.parse(startOfCivilDayIso(d, timeZone))), Date.parse(endOfCivilDayIso(to, timeZone)) + 1];
  const nowMs = Date.parse(ctx.now());

  const bottleneckCount = rows.reduce((n, r) => n + r.segments.filter((s) => s.isBottleneck).length, 0);
  const facets: FilterFacet[] = isManagement ? ["editor", "photographer", "priority"] : ctx.role === "photographer" ? ["editor", "priority"] : ["priority"];

  const description = isManagement
    ? "Every job from assignment to delivery. Stages that take more than twice the usual time are outlined so bottlenecks stand out."
    : ctx.role === "photographer"
      ? "Your jobs from assignment to delivery, stage by stage."
      : "The jobs you are editing or have edited, stage by stage.";

  return (
    <PageContainer width="full" className="max-w-[2000px]">
      <PageHeader eyebrow="Workspace" title="Timeline" description={description}>
        <FilterBar quickFilters={[]} facets={facets} searchPlaceholder="Filter by job, client, project…" />
      </PageHeader>

      <TimelineToolbar
        from={from}
        weeks={weeks}
        group={group}
        groups={groupModes}
        atDefault={from === defaultFrom}
        rangeLabel={`${formatDate(from)} – ${formatDate(to)}`}
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-muted">
        <span className="numeric font-medium text-ink-secondary">
          {rows.length} {rows.length === 1 ? "job" : "jobs"}
        </span>
        {bottleneckCount > 0 ? (
          <span className="numeric inline-flex items-center gap-1 font-medium text-attention-fg">
            <AlertTriangle aria-hidden="true" className="size-3.5" />
            {bottleneckCount} slow {bottleneckCount === 1 ? "stage" : "stages"}
          </span>
        ) : null}
        <span aria-hidden="true" className="hidden h-3 w-px bg-border sm:block" />
        <ul aria-label="Stages" className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {TIMELINE_STAGES.map((s) => (
            <li key={s.key} className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2 w-3.5 rounded-xs" style={{ backgroundColor: s.colour }} />
              {s.label}
            </li>
          ))}
        </ul>
        <span aria-hidden="true" className="hidden h-3 w-px bg-border sm:block" />
        <ul aria-label="Markers" className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2 w-3.5 rounded-xs bg-ink-subtle ring-2 ring-attention ring-offset-1 ring-offset-canvas" />
            Over {TIMELINE_BOTTLENECK_FACTOR}× average
          </li>
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2 w-3.5 rounded-l-xs bg-gradient-to-r from-ink-subtle from-60% to-transparent" />
            Current stage
          </li>
          <li className="inline-flex items-center gap-1.5">
            <Diamond aria-hidden="true" className="size-2.5 fill-surface text-ink-muted" />
            Due date
          </li>
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-3 w-px bg-accent" />
            Now
          </li>
        </ul>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          bordered
          icon={ChartNoAxesGantt}
          title={filtered ? "No jobs match these filters" : "No work in this window"}
          description={
            filtered
              ? "Clear a filter or the search to see more jobs on the timeline."
              : "No job had an active stage between these dates. Move the window or widen it to 8 weeks."
          }
          action={
            filtered ? (
              <Button variant="outline" href="/workspace/timeline">
                Clear filters
              </Button>
            ) : from !== defaultFrom ? (
              <Button variant="outline" href="/workspace/timeline">
                Back to today
              </Button>
            ) : null
          }
        />
      ) : (
        <TimelineGantt
          rows={rows}
          group={group}
          days={days}
          dayStarts={dayStarts}
          nowMs={nowMs}
          today={today}
          averages={averages}
          timeZone={timeZone}
          weeks={weeks}
        />
      )}
    </PageContainer>
  );
}
