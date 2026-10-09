import type { Metadata } from "next";
import {
  AlarmClock,
  CalendarCheck,
  CalendarClock,
  CalendarRange,
  Clock,
  Layers,
  Mail,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Timer,
  Users,
} from "lucide-react";
import { AccessDenied } from "@/components/common/access-denied";
import { SectionCard } from "@/components/common/section-card";
import { StatTile } from "@/components/common/stat-tile";
import { WorkloadBand } from "@/components/jobs";
import { PageContainer } from "@/components/shell";
import { CapacityBar } from "@/components/jobs/capacity-bar";
import { CompletedWorkList, JobMiniList } from "@/components/team/job-mini-list";
import { StageTimeChart, WeeklyCompletedChart, WorkloadHistoryChart } from "@/components/team/person-charts";
import { UrlSegmented } from "@/components/team/url-segmented";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CATEGORY_GROUPS, ROLE_LABELS } from "@/lib/constants";
import { formatDuration } from "@/lib/dates";
import { formatPercent, pluralise } from "@/lib/utils";
import { loadOrgSettings } from "@/server/queries/metrics";
import { getUserDetail } from "@/server/queries/users";
import { getUserCompletedWork } from "@/server/queries/workloads";
import { guard, load, pageContext, param } from "@/server/page";

export const metadata: Metadata = { title: "Team member" };

const RANGE_OPTIONS = [
  { value: "last_7_days", label: "Last 7 days" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "last_30_days", label: "Last 30 days" },
];
const DEFAULT_RANGE = "last_30_days";

export default async function TeamUserPage({ params, searchParams }: PageProps<"/team/users/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const { ctx, db } = await pageContext();
  guard(ctx, "user.view");
  const tz = ctx.settings.timezone;

  const detail = load(() => getUserDetail(db, ctx, id));
  const { ref, profile, teams, workload: w } = detail;
  const isSelf = ref.id === ctx.userId;
  const isPhotographer = ref.role === "photographer";
  const holderKey = isPhotographer ? "photographerId" : "editorId";
  const rangeParam = param(sp, "range");
  const rangeKey = RANGE_OPTIONS.some((o) => o.value === rangeParam) ? (rangeParam as string) : DEFAULT_RANGE;
  const work = w ? load(() => getUserCompletedWork(db, ctx, ref.id, { range: rangeKey })) : null;
  const maxActive = w ? loadOrgSettings(db, ctx).maxActiveJobsPerEditor : 0;
  // Editors: the list is the jobs behind "Active" (held = WORKLOAD categories, same as WorkloadRow.active);
  // approved / delivered jobs are no longer on their plate. Photographers: every open job they shot.
  const heldCategories: readonly string[] = CATEGORY_GROUPS.WORKLOAD;
  const currentJobs = w ? (isPhotographer ? w.currentJobs : w.currentJobs.filter((j) => heldCategories.includes(j.statusCategory))) : [];
  const allWorkHref = isPhotographer
    ? `/workspace/all?photographerId=${ref.id}&statusCategory=${CATEGORY_GROUPS.ACTIVE.join(",")}`
    : `/workspace/all?editorId=${ref.id}&statusCategory=${CATEGORY_GROUPS.WORKLOAD.join(",")}`;

  const header = (
    <PageHeader
      eyebrow={[
        { label: "Team", href: isPhotographer ? "/team/photographers" : "/team/editors" },
        { label: isPhotographer ? "Photographers" : ref.role === "editor" ? "Editors" : ROLE_LABELS[ref.role], href: isPhotographer ? "/team/photographers" : "/team/editors" },
        { label: ref.name },
      ]}
      title={
        <span className="flex items-center gap-3">
          <Avatar name={ref.name} colour={ref.avatarColour || undefined} size="lg" className={ref.isActive ? undefined : "opacity-60 grayscale"} />
          <span className="min-w-0 truncate">{ref.name}</span>
          {!ref.isActive ? <Badge variant="neutral">Deactivated</Badge> : null}
          {isSelf ? <Badge variant="accent">You</Badge> : null}
        </span>
      }
      description={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>{profile?.title ?? ROLE_LABELS[ref.role]}</span>
          {teams.length ? (
            <span className="inline-flex items-center gap-1">
              <Users aria-hidden="true" className="size-3.5 text-ink-subtle" />
              {teams.map((t) => t.name).join(" · ")}
            </span>
          ) : null}
          {profile?.email ? (
            <a href={`mailto:${profile.email}`} className="inline-flex items-center gap-1 hover:text-ink focus-ring rounded-xs">
              <Mail aria-hidden="true" className="size-3.5 text-ink-subtle" />
              {profile.email}
            </a>
          ) : null}
        </span>
      }
      actions={
        <>
          {w ? (
            <Button variant="outline" href={`/workspace/all?${holderKey}=${ref.id}`} leadingIcon={<Layers aria-hidden="true" />}>
              Their jobs
            </Button>
          ) : null}
          {detail.canManage ? (
            <Button variant="outline" href={`/settings/users/${ref.id}`} leadingIcon={<Settings2 aria-hidden="true" />}>
              Manage
            </Button>
          ) : null}
        </>
      }
    />
  );

  if (!profile) {
    return (
      <PageContainer>
        {header}
        <AccessDenied
          title="Workload details are private"
          description={`Only managers and ${ref.name.split(" ")[0]} can see their jobs, workload and performance.`}
          action={<Button variant="outline" href={isPhotographer ? "/team/photographers" : "/team/editors"}>Back to the directory</Button>}
        />
      </PageContainer>
    );
  }

  if (!w || !work) {
    return (
      <PageContainer>
        {header}
        <EmptyState
          icon={ShieldCheck}
          title={`${ROLE_LABELS[ref.role]}s don't carry a production workload`}
          description="Workload, stage times and on-time figures are tracked for editors and photographers. Managers' review activity shows up in Insights."
          action={<Button href="/insights/analytics">Open analytics</Button>}
          bordered
        />
      </PageContainer>
    );
  }

  const capacity = detail.capacityHoursPerWeek ?? w.editor.capacityHoursPerWeek;
  const onTimeTone = w.onTimePercent === null ? "default" : w.onTimePercent >= 85 ? "success" : w.onTimePercent < 70 ? "attention" : "default";
  const otherSide = isPhotographer ? "editor" : "photographer";
  const rangeLabel = work.range.label;

  return (
    <PageContainer>
      {header}

      {!isPhotographer ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-3 shadow-xs sm:flex-row sm:items-center sm:gap-6">
          <div className="flex items-center gap-3">
            <span className="eyebrow">Workload</span>
            <WorkloadBand band={w.band} ratio={w.ratio} reason={w.bandReason} showRatio />
          </div>
          <CapacityBar ratio={w.ratio} band={w.band} capacityHours={capacity} loadHours={w.score} className="flex-1" />
          <span className="text-sm text-ink-muted">
            <span className="numeric font-medium text-ink">{w.score.toFixed(1)}h</span> weighted load of{" "}
            <span className="numeric font-medium text-ink">{capacity}h</span>/week
          </span>
        </div>
      ) : null}

      <section aria-label="Key figures" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Active" value={w.active} sub={w.paused ? `${w.paused} paused` : isPhotographer ? "Open jobs they shot" : "Editor-held + in review"} icon={Layers} />
        <StatTile label="Due today" value={w.dueToday} tone={w.dueToday > 0 ? "attention" : "default"} sub={`${w.dueWithin48h} more within 48h`} icon={CalendarClock} />
        <StatTile label="Overdue" value={w.overdue} tone={w.overdue > 0 ? "danger" : "success"} sub={w.overdue > 0 ? "Needs attention" : "Nothing overdue"} icon={AlarmClock} />
        <StatTile label="Completed this week" value={w.completedThisWeek} icon={CalendarCheck} />
        <StatTile label="Completed this month" value={w.completedThisMonth} icon={CalendarRange} />
        <StatTile
          label="Revision rate"
          value={w.revisionRate === null ? "—" : formatPercent(w.revisionRate)}
          tone={w.revisionRate !== null && w.revisionRate > 0.4 ? "attention" : "default"}
          sub="Approved jobs, last 30 days"
          icon={RotateCcw}
        />
        <StatTile label="On time" value={w.onTimePercent === null ? "—" : `${Math.round(w.onTimePercent)}%`} tone={onTimeTone} sub="Approved by the due date" icon={Clock} />
        <StatTile
          label="Avg completion time"
          value={w.avgTurnaroundSeconds === null ? "—" : formatDuration(w.avgTurnaroundSeconds * 1000)}
          sub={w.avgEditingSeconds !== null && !isPhotographer ? `${formatDuration(w.avgEditingSeconds * 1000)} editing` : "Assigned → approved"}
          icon={Timer}
        />
      </section>

      {!isPhotographer ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
          <WorkloadHistoryChart history={w.history} maxActive={maxActive} className="xl:col-span-3" />
          <StageTimeChart secondsPerCategory={w.secondsPerCategory} className="xl:col-span-2" />
        </div>
      ) : null}

      {w.overdueJobs.length > 0 ? (
        <SectionCard
          title="Overdue"
          tone="danger"
          description={`${pluralise(w.overdueJobs.length, "job")} past the editing deadline — start here.`}
          flush
        >
          <JobMiniList jobs={w.overdueJobs} timeZone={tz} person={otherSide} />
        </SectionCard>
      ) : null}

      <SectionCard
        title="Current jobs"
        description={
          currentJobs.length
            ? `${pluralise(currentJobs.length, isPhotographer ? "open job" : "active job")}${isPhotographer ? "" : " (editor-held + in review)"}, soonest due first.`
            : undefined
        }
        actions={
          currentJobs.length ? (
            <Button variant="ghost" size="sm" href={allWorkHref}>
              Open in All Work
            </Button>
          ) : null
        }
        flush
      >
        <JobMiniList
          jobs={currentJobs}
          timeZone={tz}
          person={otherSide}
          empty={
            <EmptyState
              icon={Layers}
              size="sm"
              title="Nothing on their plate"
              description={isPhotographer ? "No open jobs from their shoots right now." : "No jobs assigned right now — a good candidate for the next one."}
            />
          }
        />
      </SectionCard>

      <WeeklyCompletedChart weekly={work.weekly} />

      <SectionCard
        id="work"
        title={isSelf ? "What you worked on" : `What ${ref.name.split(" ")[0]} worked on`}
        description={`${pluralise(work.items.length, "job")} approved or completed · ${rangeLabel}`}
        actions={<UrlSegmented param="range" options={RANGE_OPTIONS} defaultValue={DEFAULT_RANGE} aria-label="Range" />}
        flush
      >
        <CompletedWorkList
          items={work.items}
          timeZone={tz}
          person={otherSide}
          empty={
            <EmptyState
              icon={CalendarCheck}
              size="sm"
              title="Nothing finished in this range"
              description="Try a longer range — finished jobs show here with their on-time result and finished-work link."
            />
          }
        />
      </SectionCard>
    </PageContainer>
  );
}
