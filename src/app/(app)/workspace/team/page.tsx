import type { Metadata } from "next";
import Link from "next/link";
import { forbidden } from "next/navigation";
import { AlarmClock, ArrowUpRight, Briefcase, CalendarX2, ChevronRight, FilterX, Info, UsersRound } from "lucide-react";
import { StatTile } from "@/components/common/stat-tile";
import { FilterBar, JOB_FILTER_KEYS } from "@/components/filters";
import { PersonChip } from "@/components/jobs/person";
import { WorkloadBand } from "@/components/jobs/workload-band";
import { PageContainer } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { WorkTable, toJobListInput } from "@/components/work-table";
import type { JobTableColumn } from "@/lib/constants";
import type { TeamWorkGroup } from "@/lib/types";
import { cn, pluralise } from "@/lib/utils";
import { isManagement } from "@/server/auth/permissions";
import { ValidationError } from "@/server/errors";
import { pageContext } from "@/server/page";
import { getTeamWork } from "@/server/queries/teamWork";
import { listJobTypes } from "@/server/queries/workflows";
import { canViewTeamWork } from "./access";
import { ExpandAllToggle, TeamRoleSwitch } from "./team-controls";

export const metadata: Metadata = { title: "Team Work" };

const TEAM_QUICK_FILTERS = ["overdue", "due_today", "due_this_week", "awaiting_review", "revision_required", "paused"] as const;
const GROUPS_ID = "team-work-groups";

function columnsFor(role: "editor" | "photographer"): JobTableColumn[] {
  return ["job", "client", role === "editor" ? "photographer" : "editor", "status", "priority", "dueDate", "daysRemaining", "revisionCount", "lastActivity", "link"];
}

function countsOf(group: TeamWorkGroup) {
  return {
    active: group.jobs.length,
    dueToday: group.jobs.filter((j) => j.isDueToday).length,
    overdue: group.jobs.filter((j) => j.isOverdue).length,
    review: group.jobs.filter((j) => j.statusCategory === "submitted" || j.statusCategory === "review" || j.statusCategory === "resubmitted").length,
  };
}

/** Team Work (spec §8, ARCHITECTURE §10): active jobs grouped by the person holding them. */
export default async function TeamWorkPage({ searchParams }: PageProps<"/workspace/team">) {
  const sp = await searchParams;
  const { ctx, db } = await pageContext();
  if (!canViewTeamWork(ctx)) forbidden();
  const timeZone = ctx.settings.timezone;

  const role: "editor" | "photographer" = sp.role === "photographer" ? "photographer" : "editor";
  let notice: string | null = null;
  let groups: TeamWorkGroup[];
  try {
    groups = getTeamWork(db, ctx, toJobListInput(sp, { role }));
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    notice = "Some filters in the link were invalid and were ignored.";
    groups = getTeamWork(db, ctx, { role });
  }
  const jobTypes = listJobTypes(db, ctx).map((t) => ({ id: t.id, name: t.name, colour: t.colour }));

  const totals = groups.reduce(
    (acc, g) => {
      const c = countsOf(g);
      return { active: acc.active + c.active, dueToday: acc.dueToday + c.dueToday, overdue: acc.overdue + c.overdue };
    },
    { active: 0, dueToday: 0, overdue: 0 },
  );
  const filtered = JOB_FILTER_KEYS.some((k) => sp[k] !== undefined && sp[k] !== "");
  const personNoun = role === "editor" ? "editor" : "photographer";
  const management = isManagement(ctx);

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Workspace"
        title="Team Work"
        description={
          management
            ? "What everyone is working on right now, person by person."
            : "What you and your teammates are working on right now."
        }
        actions={<TeamRoleSwitch value={role} />}
      />

      <section aria-label="Team summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={role === "editor" ? "Editors" : "Photographers"} value={groups.length} icon={UsersRound} sub="with active work" />
        <StatTile label="Active jobs" value={totals.active} icon={Briefcase} sub="across the team" />
        <StatTile
          label="Due today"
          value={totals.dueToday}
          icon={AlarmClock}
          tone={totals.dueToday > 0 ? "attention" : "muted"}
          href="/workspace/all?quick=due_today"
          sub="Open in All Work"
        />
        <StatTile
          label="Overdue"
          value={totals.overdue}
          icon={CalendarX2}
          tone={totals.overdue > 0 ? "danger" : "muted"}
          href="/workspace/all?quick=overdue"
          sub="Open in All Work"
        />
      </section>

      <div className="flex flex-col gap-3">
        <FilterBar
          quickFilters={TEAM_QUICK_FILTERS}
          timeZone={ctx.settings.timezone}
          facets={["client", "priority", "jobType"]}
          options={{ jobTypes }}
          searchPlaceholder="Search jobs, clients, PJ-numbers…"
          trailing={groups.length > 1 ? <ExpandAllToggle targetId={GROUPS_ID} /> : null}
        />
        {notice ? (
          <p role="status" className="flex items-center gap-2 rounded-md border border-info/25 bg-info-soft/60 px-3 py-2 text-sm text-info-fg">
            <Info aria-hidden="true" className="size-4 shrink-0" />
            {notice}
          </p>
        ) : null}
      </div>

      {groups.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface shadow-xs">
          {filtered ? (
            <EmptyState
              icon={FilterX}
              title="Nobody's work matches these filters"
              description="Try another quick filter, or clear the filters to see everyone's active jobs."
              action={
                <Button href={role === "editor" ? "/workspace/team" : "/workspace/team?role=photographer"} variant="outline">
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={UsersRound}
              title={`No ${personNoun}s have active work`}
              description={
                role === "editor"
                  ? "Once jobs are assigned to editors they show up here, grouped by person. Unassigned jobs live in All Work."
                  : "Active jobs appear here grouped by the photographer who shot them."
              }
              action={
                <Button href="/workspace/all?quick=unassigned" variant="outline">
                  See unassigned jobs
                </Button>
              }
            />
          )}
        </div>
      ) : (
        <div id={GROUPS_ID} className="flex flex-col gap-3">
          {groups.map((group) => {
            const c = countsOf(group);
            const self = group.user.id === ctx.userId;
            const profileHref = management || self ? `/team/users/${group.user.id}` : null;
            return (
              <details
                key={group.user.id}
                id={`person-${group.user.id}`}
                data-team-group
                open
                className="group/team overflow-hidden rounded-lg border border-border bg-surface shadow-xs"
              >
                <summary
                  className={cn(
                    "flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 select-none [&::-webkit-details-marker]:hidden",
                    "transition-colors duration-(--motion-fast) hover:bg-surface-muted/50 focus-ring-inset",
                  )}
                >
                  <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-muted transition-transform duration-(--motion-fast) group-open/team:rotate-90" />
                  <span className="flex min-w-0 flex-1 items-center gap-3">
                    <PersonChip user={group.user} size="md" className="min-w-0 font-medium text-ink" />
                    {self ? <span className="rounded-full bg-accent-soft px-2 py-0.5 text-2xs font-medium text-accent-ink">You</span> : null}
                    {group.workload ? (
                      <WorkloadBand band={group.workload.band} ratio={group.workload.ratio} reason={group.workload.bandReason} showRatio size="sm" />
                    ) : null}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5 pl-7 text-xs sm:pl-0">
                    <CountPill label="active" value={c.active} />
                    <CountPill label="due today" value={c.dueToday} tone="attention" />
                    <CountPill label="overdue" value={c.overdue} tone="danger" />
                    {c.review > 0 ? <CountPill label="in review" value={c.review} /> : null}
                  </span>
                </summary>
                <div className="border-t border-border">
                  <WorkTable
                    rows={group.jobs}
                    timeZone={timeZone}
                    label={`${group.user.name}'s active jobs`}
                    columns={columnsFor(role)}
                    hidePerson={role}
                    embedded
                  />
                  {profileHref || group.workload ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface-sunken/60 px-4 py-2 text-xs text-ink-muted">
                      <span className="numeric">
                        {group.workload
                          ? `${group.workload.completedThisWeek} completed this week · ${group.workload.completedThisMonth} this month`
                          : pluralise(c.active, "active job")}
                      </span>
                      {profileHref ? (
                        <Link href={profileHref} className="inline-flex items-center gap-1 rounded-xs font-medium text-accent-ink hover:underline focus-ring">
                          {self ? "Your workload" : "Workload & history"}
                          <ArrowUpRight aria-hidden="true" className="size-3.5" />
                        </Link>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </details>
            );
          })}
        </div>
      )}
    </PageContainer>
  );
}

function CountPill({ label, value, tone }: { label: string; value: number; tone?: "attention" | "danger" }) {
  const active = value > 0 && tone;
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-full px-2 numeric",
        active === "danger" ? "bg-danger-soft text-danger-fg" : active === "attention" ? "bg-attention-soft text-attention-fg" : "bg-surface-muted text-ink-secondary",
        value === 0 && tone && "text-ink-subtle",
      )}
    >
      <span className="font-semibold">{value}</span>
      {label}
    </span>
  );
}
