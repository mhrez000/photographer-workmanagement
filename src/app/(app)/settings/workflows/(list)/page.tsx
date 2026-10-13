import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, Workflow } from "lucide-react";
import { PageContainer } from "@/components/shell/page-container";
import { CreateWorkflowDialog } from "@/components/settings/create-workflow-dialog";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import type { WorkflowListItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { listWorkflows } from "@/server/queries/workflows";
import { advancedPageContext, allowed, guard, load } from "@/server/page";

export const metadata: Metadata = { title: "Workflows" };

function WorkflowRow({ w }: { w: WorkflowListItem }) {
  const archived = w.archivedAt !== null;
  return (
    <li>
      <Link
        href={`/settings/workflows/${w.id}`}
        className={cn(
          "group flex items-center gap-4 px-5 py-4 transition-colors duration-(--motion-fast) hover:bg-surface-muted/60 focus-ring-inset",
          archived && "opacity-60",
        )}
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-surface-muted text-ink-muted ring-1 ring-inset ring-border">
          <Workflow aria-hidden="true" className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink group-hover:text-accent-ink">{w.name}</span>
            {w.isDefault ? (
              <Badge variant="accent" size="sm">
                Default
              </Badge>
            ) : null}
            {archived ? (
              <Badge variant="outline" size="sm">
                Archived
              </Badge>
            ) : null}
          </div>
          {w.description ? <p className="mt-0.5 line-clamp-1 text-sm text-ink-muted">{w.description}</p> : null}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {w.jobTypes.length === 0 ? (
              <span className="text-xs text-ink-subtle">No job types use it</span>
            ) : (
              w.jobTypes.map((t) => (
                <span key={t.id} className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-2xs text-ink-secondary">
                  <span aria-hidden="true" className="size-1.5 rounded-full" style={{ backgroundColor: t.colour }} />
                  {t.name}
                </span>
              ))
            )}
          </div>
        </div>
        <dl className="hidden shrink-0 grid-cols-2 gap-6 text-right sm:grid">
          <div>
            <dt className="text-2xs uppercase tracking-wider text-ink-subtle">Statuses</dt>
            <dd className="numeric text-md font-semibold text-ink">{w.statusCount}</dd>
          </div>
          <div>
            <dt className="text-2xs uppercase tracking-wider text-ink-subtle">Open jobs</dt>
            <dd className="numeric text-md font-semibold text-ink">{w.openJobCount}</dd>
          </div>
        </dl>
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-subtle" />
      </Link>
    </li>
  );
}

export default async function WorkflowsSettingsPage() {
  const { ctx, db } = await advancedPageContext("workflows", "/settings/studio"); // Advanced gate before any query (see src/server/page.ts)
  guard(ctx, "workflow.view");
  const workflows = await load(() => listWorkflows(db, ctx));
  const canManage = allowed(ctx, "workflow.manage");
  const live = workflows.filter((w) => w.archivedAt === null);
  const archived = workflows.filter((w) => w.archivedAt !== null);
  const sources = live.map((w) => ({ id: w.id, name: w.name, isDefault: w.isDefault }));

  return (
    <PageContainer width="narrow">
      <PageHeader
        eyebrow="Settings"
        title="Workflows"
        description="The statuses a job moves through and who may move it. Every status maps to a category, so dashboards and automations keep working after you rename things."
        meta={canManage ? null : <Badge variant="outline">Read-only</Badge>}
        actions={canManage ? <CreateWorkflowDialog workflows={sources} /> : undefined}
      />
      {live.length === 0 ? (
        <Card>
          <EmptyState
            icon={Workflow}
            title="No workflows"
            description="Create one from the standard photography template to start creating jobs."
            action={canManage ? <CreateWorkflowDialog workflows={sources} triggerLabel="Create from template" /> : undefined}
          />
        </Card>
      ) : (
        <Card flush className="overflow-hidden">
          <ul className="divide-y divide-border">
            {live.map((w) => (
              <WorkflowRow key={w.id} w={w} />
            ))}
          </ul>
        </Card>
      )}
      {archived.length > 0 ? (
        <section aria-labelledby="archived-workflows" className="flex flex-col gap-2">
          <h2 id="archived-workflows" className="eyebrow">
            Archived
          </h2>
          <Card flush className="overflow-hidden">
            <ul className="divide-y divide-border">
              {archived.map((w) => (
                <WorkflowRow key={w.id} w={w} />
              ))}
            </ul>
          </Card>
        </section>
      ) : null}
    </PageContainer>
  );
}
