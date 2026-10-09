import type { Metadata } from "next";
import Link from "next/link";
import { AlarmClock, Briefcase, CalendarClock, CircleCheck, FolderOpen, FolderPlus, Mail, Phone, Plus } from "lucide-react";
import { ActivityFeed } from "@/components/activity";
import { SectionCard } from "@/components/common/section-card";
import { StatTile } from "@/components/common/stat-tile";
import { PersonChip } from "@/components/jobs/person";
import { ArchiveControl } from "@/components/production/archive-control";
import { EditClientDialog } from "@/components/production/client-form";
import { JobsDoneBar, CountsInline } from "@/components/production/counts";
import { ProductionJobsTable } from "@/components/production/jobs-table";
import { PageContainer } from "@/components/shell";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { formatDate } from "@/lib/dates";
import { allowed, guard, load, pageContext } from "@/server/page";
import { listActivity } from "@/server/queries/activity";
import { getClientDetail } from "@/server/queries/clients";
import { listUsers } from "@/server/queries/users";

export const metadata: Metadata = { title: "Client" };

const ACTIVITY_PREVIEW = 15;

export default async function ClientDetailPage({ params }: PageProps<"/clients/[id]">) {
  const { ctx, db } = await pageContext();
  guard(ctx, "client.view");
  const { id } = await params;
  const tz = ctx.settings.timezone;
  const detail = load(() => getClientDetail(db, ctx, id));
  const { client, counts } = detail;
  const resource = { organisationId: ctx.organisationId, createdByUserId: client.createdByUserId ?? undefined };
  const canEdit = allowed(ctx, "client.edit", resource);
  const canArchive = allowed(ctx, "client.archive", resource);
  const canCreateProject = allowed(ctx, "project.create") && !client.archivedAt;
  const canCreateJob = allowed(ctx, "job.create") && !client.archivedAt;
  const canSeeActivity = allowed(ctx, "activity.view_global");
  const activity = canSeeActivity ? load(() => listActivity(db, ctx, { clientId: client.id, limit: ACTIVITY_PREVIEW })) : null;
  const people: Record<string, string> = canSeeActivity ? Object.fromEntries(load(() => listUsers(db, ctx)).map((u) => [u.id, u.name])) : {};
  const activeProjects = detail.projects.filter((p) => !p.project.archivedAt);
  const archivedProjects = detail.projects.filter((p) => p.project.archivedAt);

  return (
    <PageContainer>
      <PageHeader
        eyebrow={[{ label: "Production" }, { label: "Clients", href: "/clients" }, { label: client.name }]}
        title={
          <span className="flex items-center gap-3">
            <Avatar name={client.name} colour={client.colour} size="lg" shape="rounded" />
            {client.name}
          </span>
        }
        meta={client.archivedAt ? <Badge variant="outline">Archived {formatDate(client.archivedAt, tz)}</Badge> : null}
        description={
          client.contactName || client.email || client.phone ? (
            <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              {client.contactName ? <span className="text-ink-secondary">{client.contactName}</span> : null}
              {client.email ? (
                <a href={`mailto:${client.email}`} className="inline-flex items-center gap-1.5 rounded-xs hover:text-ink focus-ring">
                  <Mail aria-hidden="true" className="size-3.5" />
                  {client.email}
                </a>
              ) : null}
              {client.phone ? (
                <a href={`tel:${client.phone.replace(/\s+/g, "")}`} className="inline-flex items-center gap-1.5 rounded-xs hover:text-ink focus-ring numeric">
                  <Phone aria-hidden="true" className="size-3.5" />
                  {client.phone}
                </a>
              ) : null}
            </span>
          ) : (
            "No contact details yet."
          )
        }
        actions={
          <>
            {canArchive ? (
              <ArchiveControl entity="client" id={client.id} name={client.name} version={client.version} archived={Boolean(client.archivedAt)} openJobs={counts.open} timeZone={tz} />
            ) : null}
            {canEdit ? <EditClientDialog client={client} notes={detail.notes} canSeeNotes={ctx.role !== "editor"} timeZone={tz} /> : null}
            {canCreateProject ? (
              <Button href={`/projects/new?clientId=${client.id}`} size="sm" leadingIcon={<FolderPlus aria-hidden="true" />}>
                New project
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Open jobs" value={counts.open} icon={Briefcase} sub={`${detail.projectCount} active project${detail.projectCount === 1 ? "" : "s"}`} />
        <StatTile label="Overdue" value={counts.overdue} icon={AlarmClock} tone={counts.overdue > 0 ? "danger" : "muted"} sub={counts.overdue > 0 ? "Needs attention" : "All on track"} />
        <StatTile label="Due today" value={counts.dueToday} icon={CalendarClock} tone={counts.dueToday > 0 ? "attention" : "muted"} sub={counts.nextDueDate ? `Next due ${formatDate(counts.nextDueDate, tz)}` : "Nothing scheduled"} />
        <StatTile label="Completed" value={counts.completed} icon={CircleCheck} tone="success" sub={`${counts.completedThisMonth} this month`} />
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-6">
          <SectionCard
            title="Projects"
            description="Each project groups the jobs for one property or shoot."
            flush
            actions={
              canCreateProject ? (
                <Button href={`/projects/new?clientId=${client.id}`} variant="ghost" size="sm" leadingIcon={<Plus aria-hidden="true" />}>
                  Add
                </Button>
              ) : null
            }
          >
            {detail.projects.length === 0 ? (
              <EmptyState
                icon={FolderOpen}
                size="sm"
                title="No projects yet"
                description="Create a project for each property or campaign, then add its jobs."
                action={
                  canCreateProject ? (
                    <Button href={`/projects/new?clientId=${client.id}`} size="sm" variant="outline" leadingIcon={<FolderPlus aria-hidden="true" />}>
                      New project
                    </Button>
                  ) : null
                }
              />
            ) : (
              <ul className="divide-y divide-border">
                {[...activeProjects, ...archivedProjects].map(({ project, counts: pc }) => (
                  <li key={project.id}>
                    <Link
                      href={`/projects/${project.id}`}
                      className="grid gap-2 px-5 py-3 transition-colors duration-(--motion-fast) hover:bg-surface-muted focus-visible:bg-surface-muted focus-ring sm:grid-cols-[minmax(0,1fr)_180px] sm:items-center sm:gap-6"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-ink">{project.name}</span>
                          {project.archivedAt ? (
                            <Badge size="sm" variant="outline">
                              Archived
                            </Badge>
                          ) : null}
                        </div>
                        {project.address && project.address !== project.name ? <div className="truncate text-xs text-ink-muted">{project.address}</div> : null}
                        <CountsInline counts={pc} className="mt-1" />
                      </div>
                      <JobsDoneBar completed={pc.completed} total={pc.total} label={`${project.name} completion`} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            title="Jobs"
            description={counts.total > 0 ? <span className="numeric">{counts.total} job{counts.total === 1 ? "" : "s"} for this client</span> : undefined}
            flush
          >
            {detail.jobs.length === 0 ? (
              <EmptyState
                icon={Briefcase}
                size="sm"
                title="No jobs for this client yet"
                description={detail.projects.length === 0 ? "Start with a project, then add jobs to it." : "Add a job to one of this client's projects."}
                action={
                  canCreateJob && activeProjects[0] ? (
                    <Button href={`/jobs/new?projectId=${activeProjects[0].project.id}`} size="sm" variant="outline" leadingIcon={<Plus aria-hidden="true" />}>
                      New job
                    </Button>
                  ) : null
                }
              />
            ) : (
              <ProductionJobsTable jobs={detail.jobs} timeZone={tz} showProject />
            )}
          </SectionCard>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <SectionCard title="Details" as="h2">
            <dl className="grid gap-3 text-sm">
              {ctx.role !== "editor" ? (
                <div>
                  <dt className="eyebrow">Notes</dt>
                  <dd className="mt-1 whitespace-pre-line text-ink-secondary">{detail.notes || <span className="text-ink-subtle">No notes yet.</span>}</dd>
                </div>
              ) : null}
              <div>
                <dt className="eyebrow">Added</dt>
                <dd className="mt-1 flex flex-wrap items-center gap-2 text-ink-secondary">
                  <span className="numeric">{formatDate(client.createdAt, tz)}</span>
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
            <SectionCard
              title="Activity"
              description="Changes to this client, its projects and jobs."
            >
              <ActivityFeed
                initialItems={activity.items}
                initialCursor={activity.nextCursor}
                query={{ clientId: client.id, limit: String(ACTIVITY_PREVIEW) }}
                timeZone={tz}
                people={people}
                compact
                empty={<p className="py-6 text-center text-sm text-ink-muted">No activity recorded for this client yet.</p>}
              />
            </SectionCard>
          ) : null}
        </div>
      </div>
    </PageContainer>
  );
}
