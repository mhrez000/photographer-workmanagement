import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Plus, TriangleAlert, Zap } from "lucide-react";
import { PageContainer } from "@/components/shell/page-container";
import { describeRule } from "@/components/settings/automation-describe";
import { loadAutomationLookups } from "@/components/settings/automation-lookups";
import { AutomationToggle } from "@/components/settings/automation-toggle";
import { RunStatusBadge } from "@/components/settings/run-status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { formatDateTime, formatRelative } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { listAutomationRuns, listAutomations } from "@/server/queries/automations";
import { allowed, guard, load, pageContext } from "@/server/page";

export const metadata: Metadata = { title: "Automations" };

export default async function AutomationsSettingsPage() {
  const { ctx, db } = await pageContext();
  guard(ctx, "automation.manage");
  const tz = ctx.settings.timezone;
  const rules = await load(() => listAutomations(db, ctx));
  const { lookup } = await loadAutomationLookups(db, ctx);
  const canSeeRuns = allowed(ctx, "automation.view_runs");
  const lastRun = new Map(
    await Promise.all(
      rules.map(
        async (r) =>
          [r.id, canSeeRuns && r.runCounts.total > 0 ? ((await listAutomationRuns(db, ctx, { automationId: r.id, limit: 1 })).items[0] ?? null) : null] as const,
      ),
    ),
  );
  const killSwitchOff = !ctx.settings.automationsEnabled;
  const enabledCount = rules.filter((r) => r.isEnabled).length;

  return (
    <PageContainer width="narrow">
      <PageHeader
        eyebrow="Settings"
        title="Automations"
        description="Simple rules: when something happens to a job, do something — notify, reassign, move, prioritise or add a note. Every run is logged."
        meta={
          rules.length > 0 ? (
            <Badge variant="neutral" className="numeric">
              {enabledCount} / {rules.length} on
            </Badge>
          ) : null
        }
        actions={
          <Button href="/settings/automations/new" leadingIcon={<Plus aria-hidden="true" />}>
            New rule
          </Button>
        }
      />

      {killSwitchOff ? (
        <div role="status" className="flex items-start gap-3 rounded-lg border border-attention/25 bg-attention-soft/60 px-4 py-3 text-sm text-attention-fg">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p>
            Automations are switched off for the whole studio — rules below record skipped runs only.{" "}
            {allowed(ctx, "settings.manage") ? (
              <Link href="/settings/organisation#automations" className="font-medium underline underline-offset-2">
                Turn them back on
              </Link>
            ) : (
              "An owner can turn them back on in Organisation settings."
            )}
          </p>
        </div>
      ) : null}

      {rules.length === 0 ? (
        <Card>
          <EmptyState
            icon={Zap}
            title="No rules yet"
            description="Start from a template — notify the photographer on submission, chase overdue work, send revisions back to the original editor."
            action={
              <Button href="/settings/automations/new" leadingIcon={<Plus aria-hidden="true" />}>
                Create a rule
              </Button>
            }
          />
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {rules.map((rule) => {
            const s = describeRule(rule, lookup);
            const run = lastRun.get(rule.id) ?? null;
            return (
              <li key={rule.id}>
                <Card interactive className={cn("flex-row items-start gap-4 p-4 sm:p-5", !rule.isEnabled && "bg-surface-sunken")}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/settings/automations/${rule.id}`}
                        className="font-medium text-ink after:absolute after:inset-0 after:content-[''] hover:text-accent-ink focus-ring rounded-xs"
                      >
                        {rule.name}
                      </Link>
                      {!rule.isEnabled ? (
                        <Badge variant="outline" size="sm">
                          Off
                        </Badge>
                      ) : null}
                    </div>
                    <p className={cn("mt-1.5 text-sm leading-relaxed", rule.isEnabled ? "text-ink-secondary" : "text-ink-muted")}>
                      <span className="font-medium text-ink">{s.trigger}</span>
                      {s.conditions ? <span> {s.conditions}</span> : null}
                      <ArrowRight aria-label="then" className="mx-1.5 inline size-3.5 align-[-2px] text-accent-ink" />
                      <span>{s.actions}</span>
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-muted">
                      {run ? (
                        <span className="flex items-center gap-1.5">
                          <RunStatusBadge status={run.status} />
                          <time dateTime={run.createdAt} title={formatDateTime(run.createdAt, tz)}>
                            {formatRelative(run.createdAt)}
                          </time>
                        </span>
                      ) : (
                        <span>Never run</span>
                      )}
                      {rule.runCounts.total > 0 ? (
                        <span className="numeric">
                          {rule.runCounts.total} runs · {rule.runCounts.succeeded} succeeded
                          {rule.runCounts.failed > 0 ? <span className="text-danger"> · {rule.runCounts.failed} failed</span> : null}
                          {rule.runCounts.skipped > 0 ? ` · ${rule.runCounts.skipped} skipped` : ""}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="relative z-10 shrink-0 pt-0.5">
                    <AutomationToggle id={rule.id} name={rule.name} enabled={rule.isEnabled} version={rule.version} />
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </PageContainer>
  );
}
