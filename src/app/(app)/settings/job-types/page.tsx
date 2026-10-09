import type { Metadata } from "next";
import { PageContainer } from "@/components/shell/page-container";
import { JobTypesManager } from "@/components/settings/job-types-manager";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { getSettingsView } from "@/server/queries/settings";
import { listJobTypes, listWorkflows } from "@/server/queries/workflows";
import { allowed, guard, load, pageContext } from "@/server/page";

export const metadata: Metadata = { title: "Job types" };

export default async function JobTypesSettingsPage() {
  const { ctx, db } = await pageContext();
  guard(ctx, "job_type.manage");
  const canManage = allowed(ctx, "job_type.manage");
  const jobTypes = load(() => listJobTypes(db, ctx, { includeArchived: true }));
  const workflows = load(() => listWorkflows(db, ctx))
    .filter((w) => w.archivedAt === null)
    .map((w) => ({ id: w.id, name: w.name, isDefault: w.isDefault }));
  const settings = load(() => getSettingsView(db, ctx)).settings;

  return (
    <PageContainer width="narrow">
      <PageHeader
        eyebrow="Settings"
        title="Job types"
        description="The kinds of work you do. Each type follows a workflow and carries a typical editing estimate for workload planning."
        meta={
          <Badge variant="neutral" className="numeric">
            {jobTypes.filter((t) => t.archivedAt === null).length}
          </Badge>
        }
      />
      <JobTypesManager
        jobTypes={jobTypes}
        workflows={workflows}
        canManage={canManage}
        defaultEstimatedHours={settings.defaultEstimatedHours}
        timeZone={ctx.settings.timezone}
      />
    </PageContainer>
  );
}
