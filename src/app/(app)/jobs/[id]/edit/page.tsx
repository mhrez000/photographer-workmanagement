import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import { EditJobSimpleForm } from "@/components/job-simple";
import { StagePill } from "@/components/jobs/stage-pill";
import { PageContainer } from "@/components/shell";
import { PageHeader } from "@/components/ui/page-header";
import { NON_RUSH_PRIORITY, RUSH_PRIORITY } from "@/lib/constants";
import { loadJobRef } from "@/server/auth/job-ref";
import { allowed, load, pageContext } from "@/server/page";
import { getJobPageSimple } from "@/server/queries/jobPageSimple";
import { listJobTypes } from "@/server/queries/workflows";

export const metadata: Metadata = { title: "Edit details" };

/**
 * Edit details (docs/SIMPLIFICATION-PLAN.md §5): the simple fields only —
 * address / job name, type of shoot, shoot date, due date, client delivery
 * date (portal clients), Rush job, instructions. Status, people and links are
 * changed from the job page itself.
 */
export default async function EditJobPage({ params }: PageProps<"/jobs/[id]/edit">) {
  const { id } = await params;
  const { ctx, db } = await pageContext();
  const page = await load(() => getJobPageSimple(db, ctx, decodeURIComponent(id)));
  const { header, sideColumn } = page;
  // Full ref (draft window, project sharing, past editors) — docs/ROLES.md §2.1.
  const { ref } = await load(() => loadJobRef(db, ctx, header.id));
  const permissions = {
    fields: allowed(ctx, "job.edit_fields", ref),
    deadlines: allowed(ctx, "job.set_due_date", ref),
    rush: allowed(ctx, "job.set_priority", ref),
  };
  if (!permissions.fields && !permissions.deadlines && !permissions.rush) forbidden();

  const types = (await load(() => listJobTypes(db, ctx, { includeArchived: true }))).filter((t) => t.archivedAt === null || t.id === sideColumn.jobType.id);
  const jobTypes = types.map((t) => ({ id: t.id, name: t.name, archived: t.archivedAt !== null }));
  if (!jobTypes.some((t) => t.id === sideColumn.jobType.id)) jobTypes.unshift({ id: sideColumn.jobType.id, name: sideColumn.jobType.name, archived: false });

  return (
    <PageContainer width="narrow">
      <PageHeader
        backHref={`/jobs/${header.id}`}
        backLabel={`Back to ${header.name}`}
        eyebrow={<span className="font-mono numeric">{header.jobNumber}</span>}
        title="Edit details"
        meta={<StagePill display={header.stage} size="md" />}
        description="Who edits it, the stage and the files are changed from the job itself. Every edit here is kept in the history."
      />
      <EditJobSimpleForm
        key={header.version}
        job={{
          id: header.id,
          jobNumber: header.jobNumber,
          version: header.version,
          name: header.name,
          description: page.description,
          clientName: header.client.name,
          jobTypeId: sideColumn.jobType.id,
          priority: header.rush ? RUSH_PRIORITY : NON_RUSH_PRIORITY,
          shootDate: sideColumn.shootDate,
          dueDate: sideColumn.dueDate,
          deliveryDueDate: sideColumn.clientDeliveryDate,
        }}
        permissions={permissions}
        timeZone={ctx.settings.timezone}
        jobTypes={jobTypes}
        clientHasPortal={sideColumn.clientHasPortal}
      />
    </PageContainer>
  );
}
