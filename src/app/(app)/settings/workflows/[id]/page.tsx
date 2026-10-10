import type { Metadata } from "next";
import { PageContainer } from "@/components/shell/page-container";
import { CreateWorkflowDialog } from "@/components/settings/create-workflow-dialog";
import { WorkflowEditor, WorkflowHeaderActions } from "@/components/settings/workflow-editor";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { getWorkflowGraph, listWorkflows } from "@/server/queries/workflows";
import { allowed, guard, load, pageContext } from "@/server/page";

export const metadata: Metadata = { title: "Workflow" };

export default async function WorkflowDetailPage({ params }: PageProps<"/settings/workflows/[id]">) {
  const { ctx, db } = await pageContext();
  guard(ctx, "workflow.view");
  const { id } = await params;
  const graph = await load(() => getWorkflowGraph(db, ctx, id));
  const canManage = allowed(ctx, "workflow.manage");
  const w = graph.workflow;
  const sources = canManage
    ? (await listWorkflows(db, ctx))
        .filter((x) => x.archivedAt === null)
        .map((x) => ({ id: x.id, name: x.name, isDefault: x.isDefault }))
    : [];

  return (
    <PageContainer>
      <PageHeader
        backHref="/settings/workflows"
        backLabel="Workflows"
        title={w.name}
        meta={
          <span className="flex flex-wrap items-center gap-1.5">
            {w.isDefault ? <Badge variant="accent">Default</Badge> : null}
            {w.archivedAt ? <Badge variant="outline">Archived</Badge> : null}
            {!canManage ? <Badge variant="outline">Read-only</Badge> : null}
          </span>
        }
        description={
          <span className="flex flex-col gap-1.5">
            {w.description ? <span>{w.description}</span> : null}
            <span className="text-sm">
              <span className="numeric">{w.statusCount}</span> statuses · <span className="numeric">{w.openJobCount}</span> open jobs ·{" "}
              {w.jobTypes.length === 0 ? "no job types use it" : `used by ${w.jobTypes.map((t) => t.name).join(", ")}`}
            </span>
          </span>
        }
        actions={
          <>
            <WorkflowHeaderActions graph={graph} canManage={canManage} />
            {canManage ? <CreateWorkflowDialog workflows={sources} sourceId={w.id} triggerLabel="Duplicate" triggerVariant="outline" /> : null}
          </>
        }
      />
      <WorkflowEditor graph={graph} canManage={canManage} timeZone={ctx.settings.timezone} />
    </PageContainer>
  );
}
