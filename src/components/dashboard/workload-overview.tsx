import * as React from "react";
import Link from "next/link";
import { ArrowRight, Users } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { CapacityBar } from "@/components/jobs/capacity-bar";
import { WorkloadBand } from "@/components/jobs/workload-band";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { WorkloadBand as WorkloadBandKey } from "@/lib/constants";
import type { WorkloadRow } from "@/lib/types";
import { cn, formatPercent } from "@/lib/utils";

const BAND_ORDER: Record<WorkloadBandKey, number> = { overloaded: 0, near_capacity: 1, healthy: 2 };

/** Overloaded first, then near capacity, then by load ratio. Deactivated editors last. */
export function sortWorkloads(rows: WorkloadRow[]): WorkloadRow[] {
  return [...rows].sort((a, b) => {
    if (a.editor.isActive !== b.editor.isActive) return a.editor.isActive ? -1 : 1;
    return BAND_ORDER[a.band] - BAND_ORDER[b.band] || b.ratio - a.ratio || a.editor.name.localeCompare(b.editor.name);
  });
}

function userHref(row: WorkloadRow): string {
  return `/team/users/${row.editor.id}`;
}

function Num({ value, tone }: { value: number; tone?: "danger" | "attention" }) {
  if (value === 0) return <span className="text-ink-subtle">0</span>;
  return (
    <span className={cn(tone === "danger" && "font-semibold text-danger-fg", tone === "attention" && "font-semibold text-attention-fg")}>
      {value}
    </span>
  );
}

function RowCapacity({ row, className }: { row: WorkloadRow; className?: string }) {
  return <CapacityBar ratio={row.ratio} band={row.band} capacityHours={row.editor.capacityHoursPerWeek} loadHours={row.score} className={cn("min-w-16", className)} />;
}

const MOBILE_STATS = [
  { key: "active", label: "Assigned", tone: undefined },
  { key: "inProgress", label: "In prog.", tone: undefined },
  { key: "dueToday", label: "Today", tone: "attention" },
  { key: "overdue", label: "Overdue", tone: "danger" },
] as const;

export interface WorkloadOverviewProps {
  rows: WorkloadRow[];
  /** Show the link to the full workloads page. */
  showAllLink?: boolean;
}

/**
 * Editor workload overview (spec §3): compact table when the card is wide
 * enough (container query), cards below; secondary columns drop out first. Every row opens the person page (`/team/users/[id]`).
 */
export function WorkloadOverview({ rows, showAllLink = true }: WorkloadOverviewProps) {
  const sorted = sortWorkloads(rows);
  const counts: Record<WorkloadBandKey, number> = { overloaded: 0, near_capacity: 0, healthy: 0 };
  for (const r of rows) if (r.editor.isActive) counts[r.band] += 1;

  return (
    <SectionCard
      title="Editor workload"
      description={
        rows.length > 0 ? (
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 numeric">
            <span>🔴 {counts.overloaded} overloaded</span>
            <span>🟡 {counts.near_capacity} near capacity</span>
            <span>🟢 {counts.healthy} healthy</span>
          </span>
        ) : undefined
      }
      actions={
        showAllLink ? (
          <Link
            href="/team/workloads"
            className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-accent-ink hover:underline focus-ring"
          >
            All workloads
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        ) : null
      }
      flush
    >
      {rows.length === 0 ? (
        <EmptyState
          size="sm"
          icon={Users}
          title="No editors yet"
          description="Invite editors to see who has capacity and who is overloaded."
        />
      ) : (
        <div className="@container">
          <div className="hidden @2xl:block">
            <Table density="compact">
              <THead>
                <tr>
                  <TH>Editor</TH>
                  <TH shrink>Load</TH>
                  <TH numeric title="Active jobs held by or waiting on this editor">
                    Assigned
                  </TH>
                  <TH numeric className="hidden @3xl:table-cell">In progress</TH>
                  <TH numeric>Due today</TH>
                  <TH numeric>Overdue</TH>
                  <TH numeric title="Completed this week" className="hidden @3xl:table-cell">
                    Done this wk
                  </TH>
                  <TH numeric title="Jobs approved this month that needed at least one revision" className="hidden @4xl:table-cell">
                    Rev. rate
                  </TH>
                  <TH className="w-40">Capacity</TH>
                </tr>
              </THead>
              <TBody>
                {sorted.map((row) => (
                  <TR key={row.editor.id} interactive className={cn("relative", !row.editor.isActive && "opacity-60")}>
                    <TD primary>
                      <Link
                        href={userHref(row)}
                        className="inline-flex min-w-0 items-center gap-2 rounded-xs font-medium text-ink focus-ring after:absolute after:inset-0 hover:underline underline-offset-2"
                      >
                        <Avatar name={row.editor.name} colour={row.editor.avatarColour || undefined} size="sm" />
                        <span className="truncate">{row.editor.name}</span>
                        {!row.editor.isActive ? <span className="text-2xs font-normal text-ink-subtle">(deactivated)</span> : null}
                      </Link>
                    </TD>
                    <TD>
                      <WorkloadBand band={row.band} ratio={row.ratio} reason={row.bandReason} showLabel={false} />
                    </TD>
                    <TD numeric>
                      <Num value={row.active} />
                    </TD>
                    <TD numeric className="hidden @3xl:table-cell">
                      <Num value={row.inProgress} />
                    </TD>
                    <TD numeric>
                      <Num value={row.dueToday} tone="attention" />
                    </TD>
                    <TD numeric>
                      <Num value={row.overdue} tone="danger" />
                    </TD>
                    <TD numeric className="hidden @3xl:table-cell">
                      <Num value={row.completedThisWeek} />
                    </TD>
                    <TD numeric muted className="hidden @4xl:table-cell">
                      {row.revisionRate === null ? "—" : formatPercent(row.revisionRate)}
                    </TD>
                    <TD>
                      <RowCapacity row={row} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
          <ul className="divide-y divide-border @2xl:hidden">
            {sorted.map((row) => (
              <li key={row.editor.id}>
                <Link
                  href={userHref(row)}
                  className={cn(
                    "flex flex-col gap-2.5 px-4 py-3 focus-ring-inset active:bg-surface-muted",
                    !row.editor.isActive && "opacity-60",
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <Avatar name={row.editor.name} colour={row.editor.avatarColour || undefined} size="sm" />
                      <span className="truncate text-sm font-medium text-ink">{row.editor.name}</span>
                    </span>
                    <WorkloadBand band={row.band} ratio={row.ratio} reason={row.bandReason} />
                  </div>
                  <dl className="grid grid-cols-4 gap-2 text-center">
                    {MOBILE_STATS.map((s) => (
                      <div key={s.key} className="rounded-sm bg-surface-sunken px-1 py-1.5">
                        <dt className="text-2xs text-ink-muted">{s.label}</dt>
                        <dd className="numeric text-sm">
                          <Num value={row[s.key]} tone={s.tone} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <div className="flex items-center gap-3 text-xs text-ink-muted">
                    <RowCapacity row={row} className="flex-1" />
                    <span className="numeric shrink-0">
                      {row.completedThisWeek} done · rev {row.revisionRate === null ? "—" : formatPercent(row.revisionRate)}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}
