import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { PageContainer } from "@/components/shell";
import { PageHeader } from "@/components/ui/page-header";
import { EditJobForm } from "@/components/job-form";
import { StatusPill, jobHref } from "@/components/jobs";
import type { ClientOption, JobPermissionRef, JobTypeView, ProjectOption } from "@/lib/types";
import { allowed, load, pageContext } from "@/server/page";
import { getJobDetail } from "@/server/queries/jobDetail";
import { getClientOptions, getProjectOptions } from "@/server/queries/options";
import { listJobTypes } from "@/server/queries/workflows";

export const metadata: Metadata = { title: "Edit job" };

/**
 * Edit job fields (ARCHITECTURE §10 `/jobs/[id]/edit`). The page is open to
 * anyone who may change at least one field group (`JobDetail.actions` +
 * `job.edit_completion_percent`); the rest renders read-only.
 */
export default async function EditJobPage({ params }: PageProps<"/jobs/[id]/edit">) {
  const { id } = await params;
  const { ctx, db } = await pageContext();
  const detail = await load(() => getJobDetail(db, ctx, id));
  const { job, actions } = detail;

  const ref: JobPermissionRef = {
    id: job.id,
    organisationId: ctx.organisationId,
    photographerId: job.photographer?.id ?? null,
    editorId: job.editor?.id ?? null,
    createdByUserId: job.createdBy.id,
    statusCategory: job.statusCategory,
    isPaused: job.isPaused,
  };
  const permissions = {
    fields: actions.canEditFields,
    deadlines: actions.canEditDeadlines,
    priority: actions.canSetPriority,
    completion: allowed(ctx, "job.edit_completion_percent", ref),
  };
  if (!permissions.fields && !permissions.deadlines && !permissions.priority && !permissions.completion) forbidden();

  // Pickers; the job's own (possibly archived) client / project / type is always present.
  const jobTypes: JobTypeView[] = (await load(() => listJobTypes(db, ctx, { includeArchived: true }))).filter((t) => t.archivedAt === null || t.id === job.jobType.id);
  if (!jobTypes.some((t) => t.id === job.jobType.id)) {
    jobTypes.unshift({
      id: job.jobType.id,
      name: job.jobType.name,
      colour: job.jobType.colour,
      workflow: { id: job.workflowId, name: "" },
      defaultEstimatedHours: null,
      sortOrder: -1,
      archivedAt: null,
      version: 0,
      openJobCount: 0,
    });
  }
  const clients: ClientOption[] = permissions.fields ? await load(() => getClientOptions(db, ctx)) : [];
  if (!clients.some((c) => c.id === job.client.id)) clients.unshift({ id: job.client.id, name: job.client.name, colour: "" });
  const projects: ProjectOption[] = permissions.fields ? await load(() => getProjectOptions(db, ctx, { clientId: job.client.id })) : [];
  if (!projects.some((p) => p.id === job.project.id)) {
    projects.unshift({ id: job.project.id, name: job.project.name, clientId: job.client.id, clientName: job.client.name });
  }
  const workflowName = jobTypes.find((t) => t.id === job.jobType.id)?.workflow.name || null;

  return (
    <PageContainer>
      <PageHeader
        backHref={jobHref(job.id)}
        backLabel={`Back to ${job.jobNumber}`}
        eyebrow={<span className="font-mono numeric">{job.jobNumber}</span>}
        title={`Edit ${job.name}`}
        meta={<StatusPill status={job.status} size="sm" />}
        description="Status, people and links are changed from the job itself. Every edit here is recorded with before and after values."
      />
      <EditJobForm
        key={job.version}
        job={{
          id: job.id,
          jobNumber: job.jobNumber,
          version: job.version,
          name: job.name,
          description: job.description,
          clientId: job.client.id,
          projectId: job.project.id,
          jobTypeId: job.jobType.id,
          workflowName,
          priority: job.priority,
          shootDate: job.shootDate,
          dueDate: job.dueDate,
          reviewDueDate: job.reviewDueDate,
          deliveryDueDate: job.deliveryDueDate,
          estimatedHours: job.estimatedHours,
          completionPercent: job.completionPercent,
        }}
        permissions={permissions}
        timeZone={ctx.settings.timezone}
        jobTypes={jobTypes}
        clients={clients}
        projects={projects}
        canCreateClient={allowed(ctx, "client.create")}
        canCreateProject={allowed(ctx, "project.create")}
      />
    </PageContainer>
  );
}
