import type { Metadata } from "next";
import { PageContainer } from "@/components/shell";
import { PageHeader } from "@/components/ui/page-header";
import { CreateJobForm } from "@/components/job-form";
import { MANAGEMENT_ROLES } from "@/lib/constants";
import { getViewer } from "@/server/auth/session";
import { allowed, guard, load, pageContext, param } from "@/server/page";
import { getClientOptions, getProjectOptions } from "@/server/queries/options";
import { listJobTypes } from "@/server/queries/workflows";

export const metadata: Metadata = { title: "New job" };

/**
 * Create a job (ARCHITECTURE §10 `/jobs/new`; guard `job.create`).
 * `?clientId=` / `?projectId=` preselect the cascade (e.g. from a project page).
 */
export default async function NewJobPage({ searchParams }: PageProps<"/jobs/new">) {
  const { ctx, db } = await pageContext();
  guard(ctx, "job.create");
  const sp = await searchParams;
  const viewer = await getViewer();

  const jobTypes = await load(() => listJobTypes(db, ctx));
  const clients = await load(() => getClientOptions(db, ctx));

  let initialClientId = param(sp, "clientId") ?? null;
  let initialProjectId = param(sp, "projectId") ?? null;
  if (initialProjectId) {
    const match = (await load(() => getProjectOptions(db, ctx, {}))).find((p) => p.id === initialProjectId);
    if (match) initialClientId = match.clientId;
    else initialProjectId = null;
  }
  if (initialClientId && !clients.some((c) => c.id === initialClientId)) {
    initialClientId = null;
    initialProjectId = null;
  }
  const projects = initialClientId ? await load(() => getProjectOptions(db, ctx, { clientId: initialClientId })) : [];

  const isManagement = MANAGEMENT_ROLES.includes(ctx.role);

  return (
    <PageContainer>
      <PageHeader
        eyebrow={[{ label: "Jobs", href: "/workspace/all" }, { label: "New job" }]}
        title="New job"
        description="Set up the work once — client, people, deadlines and links — and everyone sees the same picture from here on."
      />
      <CreateJobForm
        viewer={{
          id: ctx.userId ?? "",
          name: viewer?.name ?? "You",
          role: ctx.role,
          avatarColour: viewer?.avatarColour ?? "",
        }}
        timeZone={ctx.settings.timezone}
        jobTypes={jobTypes}
        clients={clients}
        projects={projects}
        initialClientId={initialClientId}
        initialProjectId={initialProjectId}
        canPickPhotographer={isManagement}
        canAssignEditor={isManagement || ctx.role === "photographer"}
        canAddInternalNotes={isManagement}
        canCreateClient={allowed(ctx, "client.create")}
        canCreateProject={allowed(ctx, "project.create")}
      />
    </PageContainer>
  );
}
