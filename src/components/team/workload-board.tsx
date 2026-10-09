"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRightLeft, LayoutGrid, Pause, Pencil, Rows3, TriangleAlert, Users } from "lucide-react";
import { PersonChip, WorkloadBand } from "@/components/jobs";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Tooltip } from "@/components/ui/tooltip";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Table, TBody, TD, TH, THead, TR, type SortDirection } from "@/components/ui/table";
import { useUrlState } from "@/hooks/use-url-state";
import type { WorkloadRow } from "@/lib/types";
import { cn, formatPercent, pluralise } from "@/lib/utils";
import { CapacityBar } from "@/components/jobs/capacity-bar";
import { CapacityDialog } from "./capacity-dialog";
import { ReassignDrawer } from "./reassign-drawer";

export interface WorkloadBoardProps {
  rows: WorkloadRow[];
  timeZone: string;
  /** user id → { version, usesDefault } for people whose capacity this viewer may edit; null = read-only. */
  capacityEdit: Record<string, { version: number; usesDefault: boolean }> | null;
  defaultCapacityHours: number;
  canReassign: boolean;
}

type SortKey = "band" | "name" | "active" | "dueToday" | "overdue" | "completed" | "revisionRate" | "capacity";
const SORT_KEYS: SortKey[] = ["band", "name", "active", "dueToday", "overdue", "completed", "revisionRate", "capacity"];
const BAND_RANK = { overloaded: 0, near_capacity: 1, healthy: 2 } as const;

const VALUE: Record<SortKey, (r: WorkloadRow) => number | string> = {
  band: (r) => BAND_RANK[r.band] * 1000 - r.ratio,
  name: (r) => r.editor.name.toLowerCase(),
  active: (r) => r.active,
  dueToday: (r) => r.dueToday,
  overdue: (r) => r.overdue,
  completed: (r) => r.completedThisWeek,
  revisionRate: (r) => r.revisionRate ?? -1,
  capacity: (r) => r.ratio,
};
/** Natural first direction per column (most urgent first). */
const FIRST_DIR: Record<SortKey, "asc" | "desc"> = {
  band: "asc",
  name: "asc",
  active: "desc",
  dueToday: "desc",
  overdue: "desc",
  completed: "desc",
  revisionRate: "desc",
  capacity: "desc",
};

const needsReassign = (r: WorkloadRow) => !r.editor.isActive && r.active > 0;

/**
 * Editor workload table / cards (spec §12). Sortable via `?sort=&dir=`;
 * deactivated editors still holding jobs are pinned to the top with a
 * "Reassign N jobs" action; managers edit capacity inline.
 */
export function WorkloadBoard({ rows, timeZone, capacityEdit, defaultCapacityHours, canReassign }: WorkloadBoardProps) {
  const url = useUrlState();
  const view = url.get("view") === "cards" ? "cards" : "table";
  const sortParam = url.get("sort") as SortKey | null;
  const sort: SortKey = sortParam && SORT_KEYS.includes(sortParam) ? sortParam : "band";
  const dir: "asc" | "desc" = url.get("dir") === "asc" || url.get("dir") === "desc" ? (url.get("dir") as "asc" | "desc") : FIRST_DIR[sort];

  const [capacityFor, setCapacityFor] = React.useState<WorkloadRow | null>(null);
  const [reassignFrom, setReassignFrom] = React.useState<WorkloadRow | null>(null);

  const sorted = React.useMemo(() => {
    const get = VALUE[sort];
    const out = [...rows].sort((a, b) => {
      const pinned = Number(needsReassign(b)) - Number(needsReassign(a));
      if (pinned !== 0) return pinned;
      const av = get(a);
      const bv = get(b);
      const c = typeof av === "string" ? av.localeCompare(String(bv)) : av - (bv as number);
      return (dir === "asc" ? c : -c) || a.editor.name.localeCompare(b.editor.name);
    });
    return out;
  }, [rows, sort, dir]);

  const sortDir = (key: SortKey): SortDirection => (sort === key ? dir : null);
  const onSort = (key: SortKey) => () => {
    const nextDir = sort === key ? (dir === "asc" ? "desc" : "asc") : FIRST_DIR[key];
    url.patch({ sort: key === "band" && nextDir === "asc" ? null : key, dir: nextDir === FIRST_DIR[key] ? null : nextDir });
  };

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No editors to show"
        description="Once editors are invited and assigned jobs, their workload, capacity and band appear here."
        action={<Button href="/settings/users?invite=1">Invite an editor</Button>}
        bordered
      />
    );
  }

  const canEditCapacity = (r: WorkloadRow) => capacityEdit !== null && capacityEdit[r.editor.id] !== undefined && r.editor.isActive;

  const capacityCell = (r: WorkloadRow) => (
    <div className="flex items-center gap-2">
      <CapacityBar ratio={r.ratio} band={r.band} capacityHours={r.editor.capacityHoursPerWeek} loadHours={r.score} className="flex-1" />
      {canEditCapacity(r) ? (
        <button
          type="button"
          onClick={() => setCapacityFor(r)}
          className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1 py-0.5 text-xs text-ink-muted hover:bg-surface-muted hover:text-ink focus-ring"
          aria-label={`Edit capacity for ${r.editor.name} (${r.editor.capacityHoursPerWeek} hours per week)`}
          title="Edit weekly capacity"
        >
          <span className="numeric">{r.editor.capacityHoursPerWeek}h</span>
          <Pencil aria-hidden="true" className="size-3" />
        </button>
      ) : (
        <span className="shrink-0 text-xs text-ink-subtle numeric">{r.editor.capacityHoursPerWeek}h</span>
      )}
    </div>
  );

  const reassignButton = (r: WorkloadRow) =>
    canReassign && r.active > 0 ? (
      <Button
        size="sm"
        variant={needsReassign(r) ? "primary" : "ghost"}
        onClick={() => setReassignFrom(r)}
        leadingIcon={<ArrowRightLeft aria-hidden="true" />}
        aria-label={`Reassign ${r.editor.name}'s ${pluralise(r.active, "job")}`}
      >
        {needsReassign(r) ? `Reassign ${pluralise(r.active, "job")}` : "Rebalance"}
      </Button>
    ) : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-muted">
          Sorted by <span className="font-medium text-ink-secondary">{sortLabel(sort)}</span>. Bands weigh each job by estimated hours, priority and how close it is to due.
        </p>
        <SegmentedControl
          aria-label="Layout"
          size="sm"
          className="hidden md:inline-flex"
          value={view}
          onValueChange={(v) => url.set("view", v === "table" ? null : v)}
          options={[
            { value: "table", label: "Table", icon: <Rows3 className="size-3.5" aria-hidden="true" /> },
            { value: "cards", label: "Cards", icon: <LayoutGrid className="size-3.5" aria-hidden="true" /> },
          ]}
        />
      </div>

      {view === "table" ? (
        <Card flush className="hidden overflow-hidden md:block">
          <Table>
            <THead>
              <tr>
                <TH sortable sortDirection={sortDir("name")} onSort={onSort("name")}>
                  Editor
                </TH>
                <TH numeric sortable sortDirection={sortDir("active")} onSort={onSort("active")}>
                  Active
                </TH>
                <TH numeric sortable sortDirection={sortDir("dueToday")} onSort={onSort("dueToday")}>
                  Due today
                </TH>
                <TH numeric sortable sortDirection={sortDir("overdue")} onSort={onSort("overdue")}>
                  Overdue
                </TH>
                <TH numeric sortable sortDirection={sortDir("completed")} onSort={onSort("completed")} title="Completed this week">
                  Completed
                </TH>
                <TH numeric sortable sortDirection={sortDir("revisionRate")} onSort={onSort("revisionRate")} title="Approved jobs that needed a revision, last 30 days">
                  Revision rate
                </TH>
                <TH sortable sortDirection={sortDir("capacity")} onSort={onSort("capacity")} className="w-48">
                  Capacity
                </TH>
                <TH sortable sortDirection={sortDir("band")} onSort={onSort("band")}>
                  Band
                </TH>
                {canReassign ? <TH shrink><span className="sr-only">Actions</span></TH> : null}
              </tr>
            </THead>
            <TBody>
              {sorted.map((r) => (
                <TR key={r.editor.id} className={cn(needsReassign(r) && "bg-danger-soft/30", !r.editor.isActive && "text-ink-muted")}>
                  <TD>
                    <div className="flex items-center gap-2">
                      <PersonChip user={r.editor} size="sm" href={`/team/users/${r.editor.id}`} />
                      {!r.editor.isActive ? (
                        <Badge variant="danger" size="sm">
                          Deactivated
                        </Badge>
                      ) : null}
                      {needsReassign(r) && canReassign ? (
                        <Button size="sm" onClick={() => setReassignFrom(r)} leadingIcon={<ArrowRightLeft aria-hidden="true" />}>
                          Reassign {pluralise(r.active, "job")}
                        </Button>
                      ) : null}
                    </div>
                  </TD>
                  <TD numeric className="whitespace-nowrap">
                    <span className="font-medium text-ink">{r.active}</span>
                    {r.paused > 0 ? (
                      <span className="ml-1 inline-flex items-center gap-0.5 text-2xs text-ink-subtle" title={`${r.paused} paused`}>
                        <Pause aria-hidden="true" className="size-2.5" />
                        {r.paused}
                        <span className="sr-only"> paused</span>
                      </span>
                    ) : null}
                  </TD>
                  <TD numeric>
                    <span className={cn(r.dueToday > 0 && "font-medium text-attention-fg")}>{r.dueToday}</span>
                  </TD>
                  <TD numeric>
                    <span className={cn(r.overdue > 0 && "font-semibold text-danger-fg")}>{r.overdue}</span>
                  </TD>
                  <TD numeric>{r.completedThisWeek}</TD>
                  <TD numeric>
                    <span className={cn(r.revisionRate !== null && r.revisionRate > 0.4 && "font-medium text-attention-fg")}>
                      {r.revisionRate === null ? "—" : formatPercent(r.revisionRate)}
                    </span>
                  </TD>
                  <TD>{capacityCell(r)}</TD>
                  <TD>
                    <WorkloadBand band={r.band} ratio={r.ratio} reason={r.bandReason} />
                  </TD>
                  {canReassign ? (
                    <TD className="w-10 text-right">
                      {r.active > 0 && !needsReassign(r) ? (
                        <Tooltip content="Move jobs to another editor">
                          <IconButton label={`Rebalance ${r.editor.name}'s jobs`} size="sm" onClick={() => setReassignFrom(r)}>
                            <ArrowRightLeft aria-hidden="true" />
                          </IconButton>
                        </Tooltip>
                      ) : null}
                    </TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      ) : null}

      <ul className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3", view === "table" && "md:hidden")}>
        {sorted.map((r) => (
          <li key={r.editor.id}>
            <Card tone={needsReassign(r) ? "danger" : "default"} className="flex h-full flex-col gap-4 p-4">
              <div className="flex items-start gap-3">
                <Avatar name={r.editor.name} colour={r.editor.avatarColour || undefined} size="lg" className={cn(!r.editor.isActive && "opacity-60 grayscale")} />
                <div className="min-w-0 flex-1">
                  <Link href={`/team/users/${r.editor.id}`} className="block truncate text-md font-semibold text-ink hover:text-accent-ink focus-ring rounded-xs">
                    {r.editor.name}
                  </Link>
                  <div className="mt-1">
                    {needsReassign(r) ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-danger-fg">
                        <TriangleAlert aria-hidden="true" className="size-3.5" />
                        Deactivated · still holds {pluralise(r.active, "job")}
                      </span>
                    ) : (
                      <WorkloadBand band={r.band} ratio={r.ratio} reason={r.bandReason} showRatio />
                    )}
                  </div>
                </div>
              </div>
              <dl className="grid grid-cols-3 gap-3">
                <CardStat label="Active" value={r.active} />
                <CardStat label="Due today" value={r.dueToday} tone={r.dueToday > 0 ? "attention" : undefined} />
                <CardStat label="Overdue" value={r.overdue} tone={r.overdue > 0 ? "danger" : undefined} />
                <CardStat label="Done (week)" value={r.completedThisWeek} />
                <CardStat label="Revisions" value={r.revisionRate === null ? "—" : formatPercent(r.revisionRate)} />
                <CardStat label="In review" value={r.awaitingReview} />
              </dl>
              <div className="mt-auto flex flex-col gap-3 border-t border-border pt-3">
                {capacityCell(r)}
                {reassignButton(r) ? <div className="flex justify-end">{reassignButton(r)}</div> : null}
              </div>
            </Card>
          </li>
        ))}
      </ul>

      {capacityFor && capacityEdit?.[capacityFor.editor.id] ? (
        <CapacityDialog
          open
          onOpenChange={(o) => !o && setCapacityFor(null)}
          user={capacityFor.editor}
          capacityHours={capacityFor.editor.capacityHoursPerWeek}
          defaultHours={defaultCapacityHours}
          usesDefault={capacityEdit[capacityFor.editor.id].usesDefault}
          version={capacityEdit[capacityFor.editor.id].version}
          timeZone={timeZone}
        />
      ) : null}
      {reassignFrom ? (
        <ReassignDrawer open onOpenChange={(o) => !o && setReassignFrom(null)} from={reassignFrom.editor} timeZone={timeZone} />
      ) : null}
    </div>
  );
}

function CardStat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "danger" | "attention" }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-2xs uppercase tracking-wider text-ink-subtle">{label}</dt>
      <dd className={cn("mt-0.5 text-md font-semibold text-ink numeric", tone === "danger" && "text-danger-fg", tone === "attention" && "text-attention-fg")}>{value}</dd>
    </div>
  );
}

function sortLabel(key: SortKey): string {
  return {
    band: "workload band (most loaded first)",
    name: "name",
    active: "active jobs",
    dueToday: "due today",
    overdue: "overdue",
    completed: "completed this week",
    revisionRate: "revision rate",
    capacity: "capacity used",
  }[key];
}
