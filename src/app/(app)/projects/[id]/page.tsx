import type { Metadata } from "next";
import { AlarmClock, Briefcase, CircleCheck, MapPin, Plus } from "lucide-react";
import { ActivityFeed } from "@/components/activity";
import { SectionCard } from "@/components/common/section-card";
import { StatTile } from "@/components/common/stat-tile";
import { PersonChip } from "@/components/jobs/person";
import { ArchiveControl } from "@/components/production/archive-control";
import { JobsDoneBar } from "@/components/production/counts";
import { ProductionJobsTable } from "@/components/production/jobs-table";
import { EditProjectDialog } from "@/components/production/project-form";
import { ProjectTimeline, StageBreakdown } from "@/components/production/project-summary";
import { PageContainer } from "@/components/shell";
import { ProjectClientSharingSection } from "@/components/sharing/sections";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { civilDate, formatDate } from "@/lib/dates";
import type { JobRow } from "@/lib/types";
import { getViewer } from "@/server/auth/session";
import { advancedPageContext, allowed, guard, load } from "@/server/page";
import { listActivity } from "@/server/queries/activity";
import { getClientOptions } from "@/server/queries/options";
import { getProjectDetail } from "@/server/queries/projects";
import { listUsers } from "@/server/queries/users";

export const metadata: Metadata = { title: "Project" };

const ACTIVITY_PREVIEW = 15;

interface TypeGroup {
  id: string;
  name: string;
  colour: string;
  jobs: JobRow[];
}

function groupByType(jobs: JobRow[]): TypeGroup[] {
  const map = new Map<string, TypeGroup>();
  for (const job of jobs) {
    const g = map.get(job.jobType.id) ?? { id: job.jobType.id, name: job.jobType.name, colour: job.jobType.colour, jobs: [] };
    g.jobs.push(job);
    map.set(job.jobType.id, g);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export default async function ProjectDetailPage({ params }: PageProps<"/projects/[id]">) {
  const { ctx, db } = await advancedPageContext("projects", "/jobs"); // Advanced gate before any query (see src/server/page.ts)
  guard(ctx, "project.view");
  const { id } = await params;
  const tz = ctx.settings.timezone;
  const detail = await load(() => getProjectDetail(db, ctx, id));
  const { project, client, counts } = detail;
  const viewer = await getViewer();
  const resource = { organisationId: ctx.organisationId, createdByUserId: project.createdByUserId ?? undefined };
  const canEdit = allowed(ctx, "project.edit", resource);
  const canArchive = allowed(ctx, "project.archive", resource);
  const canAddJob = allowed(ctx, "job.create") && !project.archivedAt;
  const canSeeActivity = allowed(ctx, "activity.view_global");
  const activity = canSeeActivity ? await load(() => listActivity(db, ctx, { projectId: project.id, limit: ACTIVITY_PREVIEW })) : null;
  const people: Record<string, string> = canSeeActivity ? Object.fromEntries((await load(() => listUsers(db, ctx))).map((u) => [u.id, u.name])) : {};
  const clientOptions = canEdit ? await load(() => getClientOptions(db, ctx)) : [];
  if (canEdit && !clientOptions.some((c) => c.id === client.id)) clientOptions.unshift({ id: client.id, name: client.name, colour: "#64748b" });
  const groups = groupByType(detail.jobs);
  const addJobHref = `/jobs/new?projectId=${project.id}`;
  const live = counts.total - detail.jobs.filter((j) => j.statusCategory === "cancelled").length;

  return (
    <PageContainer>
      <PageHeader
        eyebrow={[
          { label: viewer?.organisationName ?? "Studio", href: "/clients" },
          { label: client.name, href: `/clients/${client.id}` },
          { label: project.name },
        ]}
        title={project.name}
        meta={project.archivedAt ? <Badge variant="outline">Archived {formatDate(project.archivedAt, tz)}</Badge> : null}
        description={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {project.address ? (
              <span className="inline-flex items-center gap-1.5">
                <MapPin aria-hidden="true" className="size-3.5" />
                {project.address}
              </span>
            ) : null}
            {project.startDate || project.endDate ? (
              <span className="numeric">
                {project.startDate ? formatDate(project.startDate, tz) : "…"} – {project.endDate ? formatDate(project.endDate, tz) : "ongoing"}
              </span>
            ) : null}
          </span>
        }
        actions={
          <>
            {canArchive ? (
              <ArchiveControl entity="project" id={project.id} name={project.name} version={project.version} archived={Boolean(project.archivedAt)} openJobs={counts.open} timeZone={tz} />
            ) : null}
            {canEdit ? (
              <EditProjectDialog
                project={project}
                startCivil={civilDate(project.startDate, tz)}
                endCivil={civilDate(project.endDate, tz)}
                description={detail.description}
                clients={clientOptions}
                clientLocked={counts.total > 0 || detail.jobs.length > 0}
                timeZone={tz}
              />
            ) : null}
            {canAddJob ? (
              <Button href={addJobHref} size="sm" leadingIcon={<Plus aria-hidden="true" />}>
                Add job to this project
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Jobs" value={counts.total} icon={Briefcase} sub={`${groups.length} type${groups.length === 1 ? "" : "s"}`} />
        <StatTile label="Open" value={counts.open} tone={counts.open > 0 ? "accent" : "muted"} sub={counts.dueToday > 0 ? `${counts.dueToday} due today` : counts.nextDueDate ? `Next due ${formatDate(counts.nextDueDate, tz)}` : "Nothing due"} />
        <StatTile label="Overdue" value={counts.overdue} icon={AlarmClock} tone={counts.overdue > 0 ? "danger" : "muted"} sub={counts.overdue > 0 ? "Needs attention" : "On track"} />
        <Card className="flex flex-col justify-between px-3.5 py-3">
          <div className="flex items-center justify-between">
            <span className="eyebrow">Progress</span>
            <CircleCheck aria-hidden="true" className="size-3.5 text-success" />
          </div>
          <div className="mt-1.5 text-xl font-semibold leading-7 tracking-tight text-ink numeric">
            {live > 0 ? Math.round((counts.completed / live) * 100) : 0}%
          </div>
          <JobsDoneBar completed={counts.completed} total={Math.max(live, 0)} className="mt-1" label="Project completion" />
        </Card>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-6">
          {groups.length === 0 ? (
            <Card>
              <EmptyState
                icon={Briefcase}
                title="No jobs in this project yet"
                description="Add the work for this property: photography, editing, twilight, floor plan, drone…"
                action={
                  canAddJob ? (
                    <Button href={addJobHref} leadingIcon={<Plus aria-hidden="true" />}>
                      Add the first job
                    </Button>
                  ) : null
                }
              />
            </Card>
          ) : (
            groups.map((g) => {
              const done = g.jobs.filter((j) => j.statusCategory === "completed").length;
              const liveInGroup = g.jobs.filter((j) => j.statusCategory !== "cancelled").length;
              return (
                <SectionCard
                  key={g.id}
                  id={`type-${g.id}`}
                  eyebrow="Job type"
                  title={
                    <span className="flex items-center gap-2">
                      <span aria-hidden="true" className="size-2.5 rounded-full" style={{ backgroundColor: g.colour }} />
                      {g.name}
                      <span className="text-sm font-normal text-ink-subtle numeric">{g.jobs.length}</span>
                    </span>
                  }
                  actions={<JobsDoneBar completed={done} total={liveInGroup} className="w-36" label={`${g.name} completion`} />}
                  flush
                >
                  <ProductionJobsTable jobs={g.jobs} timeZone={tz} showProject={false} showType={false} />
                </SectionCard>
              );
            })
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <ProjectClientSharingSection ctx={ctx} db={db} projectId={project.id} />

          <SectionCard title="Timeline" description="Key dates across this project's jobs.">
            <ProjectTimeline project={project} jobs={detail.jobs} timeZone={tz} now={ctx.now()} />
          </SectionCard>

          <SectionCard title="Where the work is">
            <StageBreakdown jobs={detail.jobs} />
          </SectionCard>

          <SectionCard title="Details">
            <dl className="grid gap-3 text-sm">
              <div>
                <dt className="eyebrow">Notes</dt>
                <dd className="mt-1 whitespace-pre-line text-ink-secondary">{detail.description || <span className="text-ink-subtle">No notes yet.</span>}</dd>
              </div>
              <div>
                <dt className="eyebrow">Added</dt>
                <dd className="mt-1 flex flex-wrap items-center gap-2 text-ink-secondary">
                  <span className="numeric">{formatDate(project.createdAt, tz)}</span>
                  {detail.createdBy ? (
                    <>
                      <span className="text-ink-subtle">by</span>
                      <PersonChip user={detail.createdBy} size="xs" />
                    </>
                  ) : null}
                </dd>
              </div>
            </dl>
          </SectionCard>

          {activity ? (
            <SectionCard title="Activity" description="Changes to this project and its jobs.">
              <ActivityFeed
                initialItems={activity.items}
                initialCursor={activity.nextCursor}
                query={{ projectId: project.id, limit: String(ACTIVITY_PREVIEW) }}
                timeZone={tz}
                people={people}
                compact
                empty={<p className="py-6 text-center text-sm text-ink-muted">No activity recorded for this project yet.</p>}
              />
            </SectionCard>
          ) : null}
        </div>
      </div>
    </PageContainer>
  );
}
