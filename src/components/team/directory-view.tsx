"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LayoutGrid, Rows3, SearchX, Users } from "lucide-react";
import { PersonChip, WorkloadBand } from "@/components/jobs";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchInput } from "@/components/ui/search-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useUrlState } from "@/hooks/use-url-state";
import { cn, formatPercent } from "@/lib/utils";
import { CapacityBar } from "@/components/jobs/capacity-bar";
import type { DirectoryPerson, DirectoryRole } from "./types";

export interface DirectoryViewProps {
  role: DirectoryRole;
  people: DirectoryPerson[];
  /** Viewer may see team aggregates (counts render as "—" otherwise). */
  showStats: boolean;
}

const dash = <span className="text-ink-subtle">—</span>;

function Num({ value, tone }: { value: number | null | undefined; tone?: "danger" | "attention" }) {
  if (value === null || value === undefined) return dash;
  return (
    <span className={cn("numeric", value > 0 && tone === "danger" && "font-medium text-danger-fg", value > 0 && tone === "attention" && "font-medium text-attention-fg")}>
      {value}
    </span>
  );
}

function rate(value: number | null | undefined) {
  return value === null || value === undefined ? dash : <span className="numeric">{formatPercent(value)}</span>;
}

/** Person cards (default) or a dense table; search by name, title or team. URL keeps `view` + `q`. */
export function DirectoryView({ role, people, showStats }: DirectoryViewProps) {
  const url = useUrlState();
  const router = useRouter();
  const view = url.get("view") === "table" ? "table" : "cards";
  const [query, setQuery] = React.useState(url.get("q") ?? "");

  const q = query.trim().toLowerCase();
  const shown = q
    ? people.filter((p) =>
        [p.user.name, p.title ?? "", p.email ?? "", ...p.teams.map((t) => t.name)].some((s) => s.toLowerCase().includes(q)),
      )
    : people;

  const href = (p: DirectoryPerson) => `/team/users/${p.user.id}`;
  const isEditor = role === "editor";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={query}
          onValueChange={setQuery}
          onDebouncedChange={(v) => url.set("q", v.trim() || null)}
          debounce={250}
          placeholder={`Search ${isEditor ? "editors" : "photographers"} or teams…`}
          aria-label={`Search ${isEditor ? "editors" : "photographers"}`}
          className="w-full sm:w-72"
        />
        <span className="text-sm text-ink-muted numeric" aria-live="polite">
          {shown.length} of {people.length}
        </span>
        <SegmentedControl
          aria-label="Layout"
          size="sm"
          className="ml-auto hidden md:inline-flex"
          value={view}
          onValueChange={(v) => url.set("view", v === "cards" ? null : v)}
          options={[
            { value: "cards", label: "Cards", icon: <LayoutGrid className="size-3.5" aria-hidden="true" /> },
            { value: "table", label: "Table", icon: <Rows3 className="size-3.5" aria-hidden="true" /> },
          ]}
        />
      </div>

      {people.length === 0 ? (
        <EmptyState
          icon={Users}
          title={`No ${isEditor ? "editors" : "photographers"} yet`}
          description={`Invite ${isEditor ? "editors" : "photographers"} from Settings → Users. They'll appear here with their current workload.`}
          action={<Button href="/settings/users?invite=1">Invite people</Button>}
          bordered
        />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="Nobody matches that search"
          description="Try a first name, a job title or a team name."
          action={
            <Button
              variant="outline"
              onClick={() => {
                setQuery("");
                url.set("q", null);
              }}
            >
              Clear search
            </Button>
          }
          size="sm"
          bordered
        />
      ) : view === "table" ? (
        <Card flush className="hidden overflow-hidden md:block">
          <Table>
            <THead>
              <tr>
                <TH>Name</TH>
                <TH>Teams</TH>
                <TH numeric>Active</TH>
                <TH numeric>Due today</TH>
                <TH numeric>Overdue</TH>
                {isEditor ? (
                  <>
                    <TH numeric>Done this week</TH>
                    <TH numeric>Revision rate</TH>
                    <TH>Capacity</TH>
                    <TH>Band</TH>
                  </>
                ) : (
                  <>
                    <TH numeric>Submitted (mo)</TH>
                    <TH numeric>Completed (mo)</TH>
                  </>
                )}
              </tr>
            </THead>
            <TBody>
              {shown.map((p) => (
                <TR key={p.user.id} interactive onClick={() => router.push(href(p))} className={cn(!p.user.isActive && "opacity-60")}>
                  <TD>
                    <Link href={href(p)} className="flex min-w-0 items-center gap-2.5 focus-ring rounded-sm" onClick={(e) => e.stopPropagation()}>
                      <PersonChip user={p.user} size="sm" />
                      {!p.user.isActive ? (
                        <Badge variant="neutral" size="sm">
                          Deactivated
                        </Badge>
                      ) : null}
                    </Link>
                  </TD>
                  <TD muted truncate className="max-w-48">
                    {p.teams.length ? p.teams.map((t) => t.name).join(", ") : dash}
                  </TD>
                  <TD numeric>
                    <Num value={p.stats?.active} />
                  </TD>
                  <TD numeric>
                    <Num value={p.stats?.dueToday} tone="attention" />
                  </TD>
                  <TD numeric>
                    <Num value={p.stats?.overdue} tone="danger" />
                  </TD>
                  {isEditor ? (
                    <>
                      <TD numeric>
                        <Num value={p.workload?.completedThisWeek} />
                      </TD>
                      <TD numeric>{rate(p.stats?.revisionRate)}</TD>
                      <TD className="w-40">{p.workload ? <CapacityBar ratio={p.workload.ratio} band={p.workload.band} /> : dash}</TD>
                      <TD>{p.workload ? <WorkloadBand band={p.workload.band} ratio={p.workload.ratio} reason={p.workload.bandReason} /> : dash}</TD>
                    </>
                  ) : (
                    <>
                      <TD numeric>
                        <Num value={p.output?.submitted} />
                      </TD>
                      <TD numeric>
                        <Num value={p.output?.completed ?? p.stats?.completedThisMonth} />
                      </TD>
                    </>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      ) : null}

      {shown.length > 0 ? (
        <ul className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3", view === "table" && "md:hidden")}>
          {shown.map((p) => (
            <li key={p.user.id}>
              <PersonCard person={p} role={role} href={href(p)} showStats={showStats} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PersonCard({ person: p, role, href, showStats }: { person: DirectoryPerson; role: DirectoryRole; href: string; showStats: boolean }) {
  const isEditor = role === "editor";
  const s = p.stats;
  return (
    <Link
      href={href}
      className={cn(
        "group flex h-full flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-xs focus-ring",
        "transition-[border-color,box-shadow,transform] duration-(--motion-fast) hover:-translate-y-px hover:border-border-hover hover:shadow-md",
        !p.user.isActive && "opacity-60 grayscale-[35%]",
      )}
    >
      <div className="flex items-start gap-3">
        <Avatar name={p.user.name} colour={p.user.avatarColour || undefined} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-md font-semibold text-ink group-hover:text-accent-ink">{p.user.name}</span>
            {!p.user.isActive ? (
              <Badge variant="neutral" size="sm">
                Deactivated
              </Badge>
            ) : null}
          </div>
          <p className="truncate text-sm text-ink-muted">{p.title ?? (isEditor ? "Editor" : "Photographer")}</p>
          {p.teams.length ? <p className="mt-0.5 truncate text-xs text-ink-subtle">{p.teams.map((t) => t.name).join(" · ")}</p> : null}
        </div>
        {p.workload ? <WorkloadBand band={p.workload.band} ratio={p.workload.ratio} reason={p.workload.bandReason} showLabel={false} /> : null}
      </div>

      {s ? (
        <dl className="grid grid-cols-3 gap-x-3 gap-y-3 text-sm">
          <Stat label="Active" value={<Num value={s.active} />} />
          <Stat label="Due today" value={<Num value={s.dueToday} tone="attention" />} />
          <Stat label="Overdue" value={<Num value={s.overdue} tone="danger" />} />
          {isEditor ? (
            <>
              <Stat label="Done (week)" value={<Num value={p.workload?.completedThisWeek ?? null} />} />
              <Stat label="Done (month)" value={<Num value={s.completedThisMonth} />} />
              <Stat label="Revision rate" value={rate(s.revisionRate)} />
            </>
          ) : (
            <>
              <Stat label="Submitted (mo)" value={<Num value={p.output?.submitted ?? null} />} />
              <Stat label="Completed (mo)" value={<Num value={p.output?.completed ?? s.completedThisMonth} />} />
              <Stat label="Revision rate" value={rate(s.revisionRate)} />
            </>
          )}
        </dl>
      ) : (
        <p className="text-sm text-ink-muted">{showStats ? "No activity yet." : "Workload figures are visible to managers."}</p>
      )}

      {p.workload ? (
        <div className="mt-auto flex items-center gap-3 border-t border-border pt-3">
          <span className="eyebrow shrink-0">Capacity</span>
          <CapacityBar ratio={p.workload.ratio} band={p.workload.band} className="flex-1" />
          <span className="shrink-0 text-xs text-ink-subtle numeric">{p.workload.capacityHoursPerWeek}h/wk</span>
        </div>
      ) : null}
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-2xs uppercase tracking-wider text-ink-subtle">{label}</dt>
      <dd className="mt-0.5 text-md font-semibold text-ink">{value}</dd>
    </div>
  );
}
