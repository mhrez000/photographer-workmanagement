import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, FolderOpen, FolderPlus, SearchX } from "lucide-react";
import { DueChip } from "@/components/jobs/due-chip";
import { JobsDoneBar, CountCell } from "@/components/production/counts";
import { ListToolbar } from "@/components/production/list-toolbar";
import { PageContainer } from "@/components/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { ProjectListItem } from "@/lib/types";
import { allowed, guard, load, pageContext, param } from "@/server/page";
import { getClientOptions } from "@/server/queries/options";
import { listProjects } from "@/server/queries/projects";

export const metadata: Metadata = { title: "Projects" };

/** Projects with open work first (soonest due), then the rest alphabetically. */
function byUrgency(a: ProjectListItem, b: ProjectListItem): number {
  const ad = a.counts.nextDueDate ?? null;
  const bd = b.counts.nextDueDate ?? null;
  if (ad && bd) return ad.localeCompare(bd);
  if (ad) return -1;
  if (bd) return 1;
  if (a.counts.open !== b.counts.open) return b.counts.open - a.counts.open;
  return a.project.name.localeCompare(b.project.name);
}

export default async function ProjectsPage({ searchParams }: PageProps<"/projects">) {
  const { ctx, db } = await pageContext();
  guard(ctx, "project.view");
  const sp = await searchParams;
  const q = param(sp, "q")?.trim() || undefined;
  const clientId = param(sp, "clientId") || undefined;
  const includeArchived = param(sp, "archived") === "1";
  const tz = ctx.settings.timezone;
  const projects = load(() => listProjects(db, ctx, { q, clientId, includeArchived })).sort(byUrgency);
  const clients = load(() => getClientOptions(db, ctx));
  const canCreate = allowed(ctx, "project.create");
  const filtered = Boolean(q || clientId || includeArchived);
  const clientName = clientId ? (clients.find((c) => c.id === clientId)?.name ?? null) : null;
  const newHref = clientId ? `/projects/new?clientId=${clientId}` : "/projects/new";

  const openTotal = projects.reduce((n, p) => n + p.counts.open, 0);
  const overdueTotal = projects.reduce((n, p) => n + p.counts.overdue, 0);

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Production"
        title={clientName ? `Projects · ${clientName}` : "Projects"}
        description={
          projects.length > 0 ? (
            <span className="numeric">
              {projects.length} project{projects.length === 1 ? "" : "s"} · {openTotal} open job{openTotal === 1 ? "" : "s"}
              {overdueTotal > 0 ? <span className="text-danger-fg"> · {overdueTotal} overdue</span> : null}
            </span>
          ) : (
            "Each project groups the jobs for one property, shoot or campaign."
          )
        }
        actions={
          canCreate ? (
            <Button href={newHref} leadingIcon={<FolderPlus aria-hidden="true" />}>
              New project
            </Button>
          ) : null
        }
      >
        <ListToolbar searchPlaceholder="Search projects, addresses, clients…" clients={clients} />
      </PageHeader>

      {projects.length === 0 ? (
        <Card>
          {filtered ? (
            <EmptyState
              icon={SearchX}
              title="No projects match"
              description={q ? `Nothing found for “${q}”. Try part of the address or the client's name.` : "Try another client or include archived projects."}
              action={
                <Button href="/projects" variant="outline" size="sm">
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={FolderOpen}
              title={ctx.role === "editor" ? "No projects on your jobs yet" : "No projects yet"}
              description={
                ctx.role === "editor"
                  ? "Projects appear here once you're assigned one of their jobs."
                  : "A project is usually a property, e.g. “123 Smith Street”, holding its photography, editing, twilight and floor-plan jobs."
              }
              action={
                canCreate ? (
                  <Button href="/projects/new" leadingIcon={<FolderPlus aria-hidden="true" />}>
                    Create your first project
                  </Button>
                ) : null
              }
            />
          )}
        </Card>
      ) : (
        <Card flush className="overflow-hidden">
          <div className="hidden md:block">
            <Table density="default">
              <THead>
                <tr>
                  <TH>Project</TH>
                  <TH>Client</TH>
                  <TH numeric>Open</TH>
                  <TH numeric>Overdue</TH>
                  <TH numeric>Done</TH>
                  <TH>Due soonest</TH>
                  <TH className="w-44">Progress</TH>
                </tr>
              </THead>
              <TBody>
                {projects.map(({ project, client, counts }) => (
                  <TR key={project.id} interactive className={project.archivedAt ? "opacity-70" : undefined}>
                    <TD primary className="max-w-[20rem]">
                      <Link href={`/projects/${project.id}`} className="block min-w-0 rounded-xs focus-ring">
                        <span className="flex items-center gap-2">
                          <span className="truncate underline-offset-2 hover:underline">{project.name}</span>
                          {project.archivedAt ? (
                            <Badge size="sm" variant="outline">
                              Archived
                            </Badge>
                          ) : null}
                        </span>
                        {project.address && project.address !== project.name ? (
                          <span className="block truncate text-xs font-normal text-ink-muted">{project.address}</span>
                        ) : null}
                      </Link>
                    </TD>
                    <TD muted truncate className="max-w-[12rem]">
                      <Link href={`/clients/${client.id}`} className="rounded-xs hover:text-ink hover:underline focus-ring">
                        {client.name}
                      </Link>
                    </TD>
                    <TD numeric>
                      <CountCell value={counts.open} />
                    </TD>
                    <TD numeric>
                      <CountCell value={counts.overdue} tone="danger" />
                    </TD>
                    <TD numeric>
                      <CountCell value={counts.completed} />
                    </TD>
                    <TD>
                      {counts.nextDueDate ? <DueChip due={counts.nextDueDate} timeZone={tz} compact /> : <span className="text-ink-subtle">—</span>}
                    </TD>
                    <TD>
                      <JobsDoneBar completed={counts.completed} total={counts.total} label={`${project.name} completion`} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
          <ul className="divide-y divide-border md:hidden">
            {projects.map(({ project, client, counts }) => (
              <li key={project.id}>
                <Link href={`/projects/${project.id}`} className="flex items-center gap-3 px-4 py-3 active:bg-surface-muted focus-ring">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-ink">{project.name}</span>
                      {project.archivedAt ? (
                        <Badge size="sm" variant="outline">
                          Archived
                        </Badge>
                      ) : null}
                    </div>
                    <div className="truncate text-xs text-ink-muted">{client.name}</div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-ink-muted numeric">
                      <span>{counts.open} open</span>
                      {counts.overdue > 0 ? <span className="font-medium text-danger-fg">{counts.overdue} overdue</span> : null}
                      {counts.nextDueDate ? <DueChip due={counts.nextDueDate} timeZone={tz} compact /> : null}
                    </div>
                    <JobsDoneBar completed={counts.completed} total={counts.total} className="mt-2" label={`${project.name} completion`} />
                  </div>
                  <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-subtle" />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </PageContainer>
  );
}
