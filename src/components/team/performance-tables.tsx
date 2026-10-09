"use client";

import * as React from "react";
import { Award, TriangleAlert } from "lucide-react";
import { PersonChip } from "@/components/jobs";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import { formatDuration } from "@/lib/dates";
import type { PerformanceRow, PhotographerPerformanceRow } from "@/lib/types";
import { cn, formatPercent } from "@/lib/utils";
import type { PerformanceFlag } from "./types";
import { useUrlSort } from "./use-url-sort";

const dur = (s: number | null) => (s === null ? "—" : formatDuration(s * 1000, { compact: s >= 86_400 * 3 }));
const pct100 = (p: number | null) => (p === null ? "—" : `${Math.round(p)}%`);
const ratio = (r: number | null) => (r === null ? "—" : formatPercent(r));

function Flags({ flag }: { flag: PerformanceFlag | undefined }) {
  if (!flag || (!flag.top && flag.attention.length === 0)) return null;
  return (
    <span className="inline-flex items-center gap-1">
      {flag.top ? (
        <Tooltip content={flag.top}>
          <span className="inline-flex size-5 items-center justify-center rounded-full bg-success-soft text-success" aria-label={`Highlight: ${flag.top}`} tabIndex={0}>
            <Award aria-hidden="true" className="size-3" />
          </span>
        </Tooltip>
      ) : null}
      {flag.attention.length > 0 ? (
        <Tooltip content={flag.attention.join(" · ")}>
          <span
            className="inline-flex size-5 items-center justify-center rounded-full bg-attention-soft text-attention"
            aria-label={`Needs attention: ${flag.attention.join(", ")}`}
            tabIndex={0}
          >
            <TriangleAlert aria-hidden="true" className="size-3" />
          </span>
        </Tooltip>
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Editors                                                            */
/* ------------------------------------------------------------------ */

type EditorKey =
  | "name"
  | "completed"
  | "approved"
  | "turnaround"
  | "editing"
  | "review"
  | "revisionRate"
  | "onTime"
  | "overdue"
  | "active"
  | "week"
  | "month";

const EDITOR_FIRST: Record<EditorKey, "asc" | "desc"> = {
  name: "asc",
  completed: "desc",
  approved: "desc",
  turnaround: "asc",
  editing: "asc",
  review: "asc",
  revisionRate: "asc",
  onTime: "desc",
  overdue: "desc",
  active: "desc",
  week: "desc",
  month: "desc",
};

const editorValue = (r: PerformanceRow, k: EditorKey): number | string | null =>
  ({
    name: r.user.name.toLowerCase(),
    completed: r.completed,
    approved: r.approved,
    turnaround: r.avgTurnaroundSeconds,
    editing: r.avgEditingSeconds,
    review: r.avgReviewSeconds,
    revisionRate: r.revisionRate,
    onTime: r.onTimePercent,
    overdue: r.overdue,
    active: r.active,
    week: r.completedThisWeek,
    month: r.completedThisMonth,
  })[k];

export function EditorPerformanceTable({ rows, flags }: { rows: PerformanceRow[]; flags: Record<string, PerformanceFlag> }) {
  const s = useUrlSort<EditorKey>("e", EDITOR_FIRST, "completed");
  const sorted = s.sortRows(rows, editorValue, (r) => r.user.name);
  if (rows.length === 0) {
    return <EmptyState size="sm" title="No editors yet" description="Editor performance appears once editors complete jobs." />;
  }
  const head = (k: EditorKey, label: string, opts: { numeric?: boolean; title?: string } = {}) => (
    <TH numeric={opts.numeric ?? true} sortable sortDirection={s.directionOf(k)} onSort={s.toggle(k)} title={opts.title}>
      {label}
    </TH>
  );
  return (
    <>
      <div className="hidden md:block">
        <Table>
          <THead>
            <tr>
              {head("name", "Editor", { numeric: false })}
              {head("completed", "Completed", { title: "Completed in range (latest completion)" })}
              {head("approved", "Approved", { title: "Approved in range — the base for the rates" })}
              {head("turnaround", "Turnaround", { title: "Assigned → approved, average" })}
              {head("editing", "Editing", { title: "Time in progress + revision, average" })}
              {head("review", "Review", { title: "Time waiting on review, average" })}
              {head("revisionRate", "Revisions", { title: "Approved jobs that needed ≥ 1 revision" })}
              {head("onTime", "On time", { title: "Approved by the due date" })}
              {head("overdue", "Overdue now")}
              {head("active", "Active now")}
              {head("week", "Week")}
              {head("month", "Month")}
            </tr>
          </THead>
          <TBody>
            {sorted.map((r) => {
              const flag = flags[r.user.id];
              const attention = (flag?.attention.length ?? 0) > 0;
              return (
                <TR key={r.user.id} className={cn(attention && "shadow-[inset_2px_0_0_var(--attention)]", flag?.top && "shadow-[inset_2px_0_0_var(--success)]")}>
                  <TD>
                    <span className="flex items-center gap-2">
                      <PersonChip user={r.user} size="xs" href={`/team/users/${r.user.id}`} />
                      <Flags flag={flag} />
                    </span>
                  </TD>
                  <TD numeric className="font-medium text-ink">
                    {r.completed}
                  </TD>
                  <TD numeric muted>
                    {r.approved}
                  </TD>
                  <TD numeric>{dur(r.avgTurnaroundSeconds)}</TD>
                  <TD numeric muted>
                    {dur(r.avgEditingSeconds)}
                  </TD>
                  <TD numeric muted>
                    {dur(r.avgReviewSeconds)}
                  </TD>
                  <TD numeric>
                    <span className={cn(r.revisionRate !== null && r.revisionRate > 0.4 && "font-medium text-attention-fg")}>{ratio(r.revisionRate)}</span>
                  </TD>
                  <TD numeric>
                    <span
                      className={cn(
                        r.onTimePercent !== null && r.onTimePercent < 70 && "font-medium text-attention-fg",
                        r.onTimePercent !== null && r.onTimePercent >= 90 && "text-success-fg",
                      )}
                    >
                      {pct100(r.onTimePercent)}
                    </span>
                  </TD>
                  <TD numeric>
                    <span className={cn(r.overdue > 0 && "font-semibold text-danger-fg")}>{r.overdue}</span>
                  </TD>
                  <TD numeric>{r.active}</TD>
                  <TD numeric muted>
                    {r.completedThisWeek}
                  </TD>
                  <TD numeric muted>
                    {r.completedThisMonth}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </div>
      <ul className="flex flex-col divide-y divide-border md:hidden">
        {sorted.map((r) => (
          <li key={r.user.id} className="flex flex-col gap-2 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <PersonChip user={r.user} size="sm" href={`/team/users/${r.user.id}`} />
              <Flags flag={flags[r.user.id]} />
            </div>
            <dl className="grid grid-cols-4 gap-2 text-sm">
              <MiniStat label="Done" value={r.completed} />
              <MiniStat label="On time" value={pct100(r.onTimePercent)} />
              <MiniStat label="Revisions" value={ratio(r.revisionRate)} />
              <MiniStat label="Overdue" value={r.overdue} tone={r.overdue > 0 ? "danger" : undefined} />
              <MiniStat label="Turnaround" value={dur(r.avgTurnaroundSeconds)} />
              <MiniStat label="Editing" value={dur(r.avgEditingSeconds)} />
              <MiniStat label="Active" value={r.active} />
              <MiniStat label="Week" value={r.completedThisWeek} />
            </dl>
            {flags[r.user.id]?.attention.length ? <p className="text-xs text-attention-fg">{flags[r.user.id].attention.join(" · ")}</p> : null}
          </li>
        ))}
      </ul>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Photographers                                                      */
/* ------------------------------------------------------------------ */

type PhotoKey = "name" | "created" | "submitted" | "completed" | "processing" | "endToEnd" | "review" | "active" | "overdue";

const PHOTO_FIRST: Record<PhotoKey, "asc" | "desc"> = {
  name: "asc",
  created: "desc",
  submitted: "desc",
  completed: "desc",
  processing: "asc",
  endToEnd: "asc",
  review: "asc",
  active: "desc",
  overdue: "desc",
};

const photoValue = (r: PhotographerPerformanceRow, k: PhotoKey): number | string | null =>
  ({
    name: r.user.name.toLowerCase(),
    created: r.created,
    submitted: r.submitted,
    completed: r.completed,
    processing: r.avgProcessingSeconds,
    endToEnd: r.avgEndToEndSeconds,
    review: r.avgReviewResponseSeconds,
    active: r.active,
    overdue: r.overdue,
  })[k];

export function PhotographerPerformanceTable({ rows, flags }: { rows: PhotographerPerformanceRow[]; flags: Record<string, PerformanceFlag> }) {
  const s = useUrlSort<PhotoKey>("p", PHOTO_FIRST, "submitted");
  const sorted = s.sortRows(rows, photoValue, (r) => r.user.name);
  if (rows.length === 0) {
    return <EmptyState size="sm" title="No photographers yet" description="Photographer output appears once jobs are created and submitted." />;
  }
  const head = (k: PhotoKey, label: string, opts: { numeric?: boolean; title?: string } = {}) => (
    <TH numeric={opts.numeric ?? true} sortable sortDirection={s.directionOf(k)} onSort={s.toggle(k)} title={opts.title}>
      {label}
    </TH>
  );
  return (
    <>
      <div className="hidden md:block">
        <Table>
          <THead>
            <tr>
              {head("name", "Photographer", { numeric: false })}
              {head("created", "Created")}
              {head("submitted", "Submitted", { title: "First submitted for review in range" })}
              {head("completed", "Completed")}
              {head("processing", "Shoot → submitted", { title: "Average time from the shoot date to the first submission" })}
              {head("endToEnd", "Created → completed")}
              {head("review", "Review time", { title: "Average time their jobs waited in review" })}
              {head("active", "Active now")}
              {head("overdue", "Overdue now")}
            </tr>
          </THead>
          <TBody>
            {sorted.map((r) => {
              const flag = flags[r.user.id];
              return (
                <TR key={r.user.id} className={cn((flag?.attention.length ?? 0) > 0 && "shadow-[inset_2px_0_0_var(--attention)]")}>
                  <TD>
                    <span className="flex items-center gap-2">
                      <PersonChip user={r.user} size="xs" href={`/team/users/${r.user.id}`} />
                      <Flags flag={flag} />
                    </span>
                  </TD>
                  <TD numeric muted>
                    {r.created}
                  </TD>
                  <TD numeric className="font-medium text-ink">
                    {r.submitted}
                  </TD>
                  <TD numeric>{r.completed}</TD>
                  <TD numeric>{dur(r.avgProcessingSeconds)}</TD>
                  <TD numeric muted>
                    {dur(r.avgEndToEndSeconds)}
                  </TD>
                  <TD numeric muted>
                    {dur(r.avgReviewResponseSeconds)}
                  </TD>
                  <TD numeric>{r.active}</TD>
                  <TD numeric>
                    <span className={cn(r.overdue > 0 && "font-semibold text-danger-fg")}>{r.overdue}</span>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </div>
      <ul className="flex flex-col divide-y divide-border md:hidden">
        {sorted.map((r) => (
          <li key={r.user.id} className="flex flex-col gap-2 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <PersonChip user={r.user} size="sm" href={`/team/users/${r.user.id}`} />
              <Flags flag={flags[r.user.id]} />
            </div>
            <dl className="grid grid-cols-4 gap-2 text-sm">
              <MiniStat label="Submitted" value={r.submitted} />
              <MiniStat label="Completed" value={r.completed} />
              <MiniStat label="Shoot→sub." value={dur(r.avgProcessingSeconds)} />
              <MiniStat label="Overdue" value={r.overdue} tone={r.overdue > 0 ? "danger" : undefined} />
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "danger" }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-2xs uppercase tracking-wider text-ink-subtle">{label}</dt>
      <dd className={cn("font-semibold text-ink numeric", tone === "danger" && "text-danger-fg")}>{value}</dd>
    </div>
  );
}
