import type { Metadata } from "next";
import Link from "next/link";
import { History } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { PageContainer } from "@/components/shell/page-container";
import { AutomationBuilder } from "@/components/settings/automation-builder";
import { describeAction } from "@/components/settings/automation-describe";
import { AutomationDryRun } from "@/components/settings/automation-dry-run";
import { loadAutomationLookups } from "@/components/settings/automation-lookups";
import { AutomationToggle } from "@/components/settings/automation-toggle";
import { RunStatusBadge } from "@/components/settings/run-status-badge";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { formatDateTime, formatRelative } from "@/lib/dates";
import type { AutomationRunView } from "@/lib/types";
import { getAutomationDetail } from "@/server/queries/automations";
import { allowed, guard, load, pageContext } from "@/server/page";

export async function generateMetadata({ params }: PageProps<"/settings/automations/[id]">): Promise<Metadata> {
  const { id } = await params;
  return { title: id === "new" ? "New automation" : "Automation" };
}

function RunsTable({ runs, timeZone, lookup }: { runs: AutomationRunView[]; timeZone: string; lookup: Parameters<typeof describeAction>[1] }) {
  return (
    <>
      <div className="hidden md:block">
        <Table density="default">
          <THead>
            <tr>
              <TH>Status</TH>
              <TH>Job</TH>
              <TH>When</TH>
              <TH>Actions performed</TH>
            </tr>
          </THead>
          <TBody>
            {runs.map((r) => (
              <TR key={r.id}>
                <TD className="align-top">
                  <RunStatusBadge status={r.status} />
                  {r.depth > 0 ? <span className="mt-1 block text-2xs text-ink-subtle">chained ×{r.depth}</span> : null}
                </TD>
                <TD className="align-top">
                  {r.job ? (
                    <Link href={`/jobs/${r.job.id}`} className="group block max-w-56">
                      <span className="font-mono text-xs text-accent-ink group-hover:underline">{r.job.jobNumber}</span>
                      <span className="block truncate text-ink-secondary">{r.job.name}</span>
                    </Link>
                  ) : (
                    <span className="text-ink-subtle">—</span>
                  )}
                </TD>
                <TD muted className="align-top whitespace-nowrap">
                  <time dateTime={r.createdAt} title={formatDateTime(r.createdAt, timeZone)}>
                    {formatRelative(r.createdAt)}
                  </time>
                </TD>
                <TD className="align-top">
                  {r.actionsPerformed.length === 0 ? (
                    <span className="text-ink-subtle">{r.status === "skipped" ? "Conditions not met — nothing done" : "—"}</span>
                  ) : (
                    <ul className="flex flex-col gap-0.5">
                      {r.actionsPerformed.map((a, i) => (
                        <li key={i} className={a.ok ? "text-ink-secondary" : "text-danger"}>
                          {a.ok ? "✓" : "✗"} {describeAction(a.action, lookup)}
                          {a.detail ? <span className="text-ink-muted"> — {a.detail}</span> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                  {r.error ? <p className="mt-1 text-xs text-danger">{r.error}</p> : null}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
      <ul className="divide-y divide-border md:hidden">
        {runs.map((r) => (
          <li key={r.id} className="flex flex-col gap-1.5 px-4 py-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <RunStatusBadge status={r.status} />
              <time dateTime={r.createdAt} className="text-xs text-ink-muted">
                {formatRelative(r.createdAt)}
              </time>
            </div>
            {r.job ? (
              <Link href={`/jobs/${r.job.id}`} className="truncate text-ink-secondary">
                <span className="font-mono text-xs text-accent-ink">{r.job.jobNumber}</span> {r.job.name}
              </Link>
            ) : null}
            {r.actionsPerformed.map((a, i) => (
              <p key={i} className={a.ok ? "text-xs text-ink-muted" : "text-xs text-danger"}>
                {a.ok ? "✓" : "✗"} {describeAction(a.action, lookup)}
              </p>
            ))}
            {r.error ? <p className="text-xs text-danger">{r.error}</p> : null}
          </li>
        ))}
      </ul>
    </>
  );
}

export default async function AutomationDetailPage({ params }: PageProps<"/settings/automations/[id]">) {
  const { ctx, db } = await pageContext();
  guard(ctx, "automation.manage");
  const { id } = await params;
  const tz = ctx.settings.timezone;
  const isNew = id === "new";
  const rule = isNew ? null : load(() => getAutomationDetail(db, ctx, id));
  const { users, jobTypes, clients, lookup } = loadAutomationLookups(db, ctx);
  const canSeeRuns = allowed(ctx, "automation.view_runs");

  return (
    <PageContainer width="narrow">
      <PageHeader
        backHref="/settings/automations"
        backLabel="Automations"
        title={rule ? rule.name : "New rule"}
        meta={
          rule?.archivedAt ? (
            <Badge variant="outline">Archived</Badge>
          ) : rule ? (
            <span className="flex items-center gap-2 text-sm text-ink-muted">
              <AutomationToggle id={rule.id} name={rule.name} enabled={rule.isEnabled} version={rule.version} />
              {rule.isEnabled ? "On" : "Off"}
            </span>
          ) : null
        }
        description={
          rule
            ? `Created ${formatRelative(rule.createdAt)}${rule.createdBy ? ` by ${rule.createdBy.name}` : ""} · ${rule.runCounts.total} runs${rule.lastRunAt ? ` · last ${formatRelative(rule.lastRunAt)}` : ""}`
            : "When something happens to a job, do something — automatically, with every run logged."
        }
      />

      <AutomationBuilder key={rule?.id ?? "new"} rule={rule} users={users} jobTypes={jobTypes} clients={clients} lookup={lookup} timeZone={tz} />

      {rule ? <AutomationDryRun automationId={rule.id} /> : null}

      {rule && canSeeRuns ? (
        <SectionCard
          id="runs"
          title="Run history"
          description={`Latest ${rule.recentRuns.length} of ${rule.runCounts.total} runs · ${rule.runCounts.succeeded} succeeded · ${rule.runCounts.failed} failed · ${rule.runCounts.skipped} skipped`}
          flush
        >
          {rule.recentRuns.length === 0 ? (
            <EmptyState icon={History} size="sm" title="No runs yet" description="Runs appear here the next time the trigger fires. Use the dry run to test it now." />
          ) : (
            <RunsTable runs={rule.recentRuns} timeZone={tz} lookup={lookup} />
          )}
        </SectionCard>
      ) : null}
    </PageContainer>
  );
}
