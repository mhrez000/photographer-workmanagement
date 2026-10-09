import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CircleCheckBig, Settings2 } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { DueChip, JobLink, PersonChip, StatusPill } from "@/components/jobs";
import { BottleneckJobActions } from "@/components/insights/bottleneck-job-actions";
import { BOTTLENECK_META } from "@/components/insights/bottleneck-meta";
import { PageContainer } from "@/components/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { BOTTLENECK_KINDS, STATUS_CATEGORY_META } from "@/lib/constants";
import { formatDateTime } from "@/lib/dates";
import type { BottleneckAlert, JobRow } from "@/lib/types";
import { cn, pluralise } from "@/lib/utils";
import { getBottlenecks } from "@/server/queries/bottlenecks";
import { getJobRowsByIds } from "@/server/queries/jobs";
import { loadOrgSettings } from "@/server/queries/metrics";
import { allowed, guard, load, pageContext } from "@/server/page";

export const metadata: Metadata = { title: "Bottlenecks" };

const VISIBLE_JOBS = 6;

export default async function BottlenecksPage() {
  const { ctx, db } = await pageContext();
  guard(ctx, "bottlenecks.view");
  const tz = ctx.settings.timezone;
  const alerts = load(() => getBottlenecks(db, ctx));
  const settings = loadOrgSettings(db, ctx);
  const jobIds = [...new Set(alerts.flatMap((a) => a.jobs.map((j) => j.id)))];
  const rows = new Map(load(() => getJobRowsByIds(db, ctx, jobIds)).map((j) => [j.id, j]));
  const canReassign = allowed(ctx, "job.bulk_reassign");
  const firing = new Set(alerts.map((a) => a.kind));
  const critical = alerts.filter((a) => a.severity === "critical").length;
  const checkedAt = alerts[0]?.detectedAt ?? ctx.now();

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Insights"
        title="Bottlenecks"
        description={
          alerts.length === 0
            ? "Every rule is checked against live data each time this page loads."
            : `${pluralise(alerts.length, "issue")} slowing production${critical > 0 ? `, ${critical} critical` : ""}. Most urgent first — act on the jobs directly from here.`
        }
        meta={<span className="text-xs text-ink-subtle">Checked {formatDateTime(checkedAt, tz)}</span>}
        actions={
          allowed(ctx, "settings.view") ? (
            <Button variant="outline" href="/settings/organisation#thresholds" leadingIcon={<Settings2 aria-hidden="true" />}>
              Thresholds
            </Button>
          ) : null
        }
      />

      {alerts.length === 0 ? (
        <EmptyState
          icon={CircleCheckBig}
          title="All clear"
          description="No review queue build-up, no overloaded editors, no stalled or orphaned jobs. The rules below are what we check."
          action={<Button variant="outline" href="/team/workloads">See workloads</Button>}
          bordered
          size="lg"
        />
      ) : (
        <ol className="flex flex-col gap-4" aria-label="Active bottlenecks">
          {[...alerts]
            .sort((a, b) => Number(b.severity === "critical") - Number(a.severity === "critical"))
            .map((a, i) => (
              <li key={`${a.kind}-${a.user?.id ?? i}`}>
                <AlertCard alert={a} rows={rows} timeZone={tz} canReassign={canReassign} />
              </li>
            ))}
        </ol>
      )}

      <SectionCard
        title="How bottlenecks are detected"
        description="Thresholds come from your organisation settings, so the rules match how your studio works."
        flush
      >
        <ul className="divide-y divide-border">
          {BOTTLENECK_KINDS.map((kind) => {
            const meta = BOTTLENECK_META[kind];
            const Icon = meta.icon;
            const on = firing.has(kind);
            return (
              <li key={kind} className="flex items-start gap-3 px-5 py-3">
                <span
                  className={cn(
                    "mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md",
                    on ? "bg-danger-soft text-danger" : "bg-surface-muted text-ink-subtle",
                  )}
                >
                  <Icon aria-hidden="true" className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{meta.label}</span>
                    {on ? (
                      <Badge variant="danger" size="sm" dot>
                        Firing
                      </Badge>
                    ) : (
                      <Badge variant="success" size="sm">
                        Clear
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-sm text-ink-muted">{meta.rule(settings)}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </SectionCard>
    </PageContainer>
  );
}

function AlertCard({ alert, rows, timeZone, canReassign }: { alert: BottleneckAlert; rows: Map<string, JobRow>; timeZone: string; canReassign: boolean }) {
  const meta = BOTTLENECK_META[alert.kind];
  const Icon = meta.icon;
  const critical = alert.severity === "critical";
  const jobs = alert.jobs.map((j) => ({ ref: j, row: rows.get(j.id) ?? null }));
  const hidden = alert.jobs.length - jobs.filter((j) => j.row).length;

  const jobItem = ({ ref, row }: (typeof jobs)[number]) => (
    <li key={ref.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <JobLink job={ref} />
        {row ? (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <StatusPill status={row.status} size="xs" />
            <PersonChip user={row.editor} size="xs" label={undefined} emptyLabel="No editor" />
            <DueChip due={row.dueDate} timeZone={timeZone} done={STATUS_CATEGORY_META[row.statusCategory].done} compact />
          </div>
        ) : null}
      </div>
      {row ? (
        <BottleneckJobActions
          job={{ id: row.id, jobNumber: row.jobNumber, name: row.name, version: row.version, editor: row.editor }}
          canReassign={canReassign}
          timeZone={timeZone}
        />
      ) : null}
    </li>
  );
  const visible = jobs.filter((j) => j.row);

  return (
    <Card tone={critical ? "danger" : "attention"} flush className="overflow-hidden">
      <div className="flex flex-col gap-3 px-5 pt-4 pb-3 sm:flex-row sm:items-start">
        <span
          className={cn(
            "inline-flex size-9 shrink-0 items-center justify-center rounded-md",
            critical ? "bg-danger-soft text-danger" : "bg-attention-soft text-attention",
          )}
        >
          <Icon aria-hidden="true" className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="eyebrow">{meta.label}</span>
            <Badge variant={critical ? "danger" : "attention"} size="sm">
              {critical ? "Critical" : "Warning"}
            </Badge>
          </div>
          <h2 className="mt-1 text-md font-semibold leading-6 text-ink">{alert.message}</h2>
          <p className="mt-0.5 text-sm text-ink-muted">{meta.fix}</p>
          {alert.user ? (
            <div className="mt-2">
              <PersonChip user={alert.user} size="xs" href={`/team/users/${alert.user.id}`} />
            </div>
          ) : null}
        </div>
        <Link href={alert.href} className="inline-flex shrink-0 items-center gap-1 self-start text-sm font-medium text-accent-ink hover:underline focus-ring rounded-xs">
          View all
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      </div>
      {visible.length > 0 ? (
        <div className="border-t border-border/70 bg-surface">
          <ul className="divide-y divide-border">{visible.slice(0, VISIBLE_JOBS).map(jobItem)}</ul>
          {visible.length > VISIBLE_JOBS ? (
            <details className="group border-t border-border">
              <summary className="cursor-pointer list-none px-5 py-2.5 text-sm font-medium text-accent-ink hover:bg-surface-muted/60 focus-ring-inset">
                <span className="group-open:hidden">Show {visible.length - VISIBLE_JOBS} more</span>
                <span className="hidden group-open:inline">Show fewer</span>
              </summary>
              <ul className="divide-y divide-border border-t border-border">{visible.slice(VISIBLE_JOBS).map(jobItem)}</ul>
            </details>
          ) : null}
        </div>
      ) : null}
      {hidden > 0 ? <p className="border-t border-border/70 px-5 py-2 text-xs text-ink-muted">{pluralise(hidden, "affected job")} you can&apos;t open.</p> : null}
    </Card>
  );
}
