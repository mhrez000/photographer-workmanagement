import Link from "next/link";
import { Avatar } from "@/components/ui/avatar";
import { RoundBadge, RushBadge, StagePill, WaitingOn, stageSubLabelText } from "@/components/jobs/stage-pill";
import type { SimpleJobRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FinishedLinkIcon } from "./finished-link-icon";
import { SimpleDueChip } from "./simple-due-chip";

export interface JobsTableProps {
  rows: SimpleJobRow[];
  timeZone: string;
  /** The viewer's id ("Waiting on: You"). */
  viewerId: string | null;
  className?: string;
}

function jobHref(id: string): string {
  return `/jobs/${id}`;
}

/** Address / job name, with the project address underneath when it adds something. */
function JobName({ job, className }: { job: SimpleJobRow; className?: string }) {
  const address = job.project.address?.trim();
  const showAddress = address && address.toLowerCase() !== job.name.trim().toLowerCase();
  return (
    <div className={cn("min-w-0", className)}>
      <Link href={jobHref(job.id)} title={job.name} className="block truncate font-medium text-ink underline-offset-2 hover:underline focus-ring rounded-xs">
        {job.name}
      </Link>
      <p className="truncate text-xs text-ink-muted" title={showAddress ? address : undefined}>
        {showAddress ? <span>{address} · </span> : null}
        <span className="numeric">{job.jobNumber}</span>
      </p>
    </div>
  );
}

function EditorAvatar({ job }: { job: SimpleJobRow }) {
  if (!job.editor) return <span className="whitespace-nowrap text-xs italic text-ink-subtle">No editor</span>;
  return (
    <span className="flex min-w-0 items-center gap-2" title={`Editor: ${job.editor.name}`}>
      <Avatar name={job.editor.name} size="sm" colour={job.editor.avatarColour || undefined} />
      <span className="hidden min-w-0 truncate text-sm text-ink-secondary lg:inline">{job.editor.name}</span>
    </span>
  );
}

/**
 * The stage pill with Round / Rush beside it. Round N is the badge (plan §4), never also inside
 * the pill. The pill itself carries only the stage word so narrow columns never clip it; the
 * secondary text ("Not started", "Editing since 9 Oct", "Not sent to client") sits on its own
 * line underneath.
 */
function StageCell({ job, timeZone, wrap = false }: { job: SimpleJobRow; timeZone: string; wrap?: boolean }) {
  const sub = job.stage.subLabel === "round" ? null : stageSubLabelText(job.stage, job.startedAt, timeZone);
  return (
    <div className="min-w-0">
      <div className={cn("flex min-w-0 items-center gap-1.5", wrap ? "flex-wrap" : "")}>
        <StagePill display={job.stage} hideSubLabel className="shrink-0" />
        <RoundBadge round={job.round} className="shrink-0" />
        <RushBadge rush={job.rush} className="shrink-0" />
      </div>
      {sub ? <div className="mt-0.5 truncate text-xs text-ink-muted">{sub}</div> : null}
    </div>
  );
}

/**
 * The one list of jobs (docs/SIMPLIFICATION-PLAN.md §1, §4). A table from `md` up, cards on
 * phones; the same row pieces everywhere: name · client · stage pill · "Waiting on" · due chip ·
 * Round / Rush badges · editor · finished-photos icon.
 *
 * The table is `table-fixed` so the JOB column (the address, the one thing people scan for) always
 * keeps its share of the width and the other cells truncate instead: no horizontal scroll at 1110px.
 * The finished-photos icon sits next to the name rather than in a column of its own.
 */
export function JobsTable({ rows, timeZone, viewerId, className }: JobsTableProps) {
  return (
    <div className={cn("flex flex-col", className)}>
      {/* ≥ md: table */}
      <div className="relative hidden overflow-hidden rounded-lg border border-border bg-surface shadow-xs md:block">
        <table className="w-full table-fixed border-collapse text-sm" data-jobs-table="">
          {/* table-fixed: the header row's widths decide the columns; cells truncate instead of pushing the table wider. */}
          <thead>
            <tr className="border-b border-border bg-surface-sunken/70 text-left text-2xs font-semibold uppercase tracking-wide text-ink-muted">
              <th scope="col" className="w-[34%] px-4 py-2.5 lg:w-[30%]">
                Job
              </th>
              <th scope="col" className="w-[18%] px-3 py-2.5 lg:w-[16%]">
                Client
              </th>
              <th scope="col" className="w-[22%] px-3 py-2.5 lg:w-[20%]">
                Stage
              </th>
              <th scope="col" className="w-[13%] px-3 py-2.5 lg:w-[12%]">
                Waiting on
              </th>
              <th scope="col" className="w-[13%] px-3 py-2.5 lg:w-[10%]">
                Due
              </th>
              <th scope="col" className="hidden px-3 py-2.5 lg:table-cell lg:w-[12%]">
                Editor
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((job) => (
              <tr key={job.id} className={cn("group/row align-middle transition-colors hover:bg-surface-muted/50", job.due.late && "bg-danger-soft/20")}>
                <td className="px-4 py-2.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <JobName job={job} className="flex-1" />
                    <FinishedLinkIcon link={job.finishedLink} className="-my-1 shrink-0" />
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <p className="truncate text-ink-secondary" title={job.client.name}>
                    {job.client.name}
                  </p>
                  <p className="truncate text-xs text-ink-muted">{job.jobTypeName}</p>
                </td>
                <td className="px-3 py-2.5">
                  <StageCell job={job} timeZone={timeZone} />
                </td>
                <td className="overflow-hidden px-3 py-2.5">
                  <WaitingOn job={{ category: job.statusCategory, photographer: job.photographer, editor: job.editor }} viewerId={viewerId} prefix="" className="max-w-full overflow-hidden whitespace-nowrap" />
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <SimpleDueChip due={job.due} active={job.stage.active} />
                </td>
                <td className="hidden px-3 py-2.5 lg:table-cell">
                  <EditorAvatar job={job} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* phones: cards */}
      <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface shadow-xs md:hidden">
        {rows.map((job) => (
          <li key={job.id} className={cn("flex flex-col gap-2 px-4 py-3", job.due.late && "bg-danger-soft/20")}>
            <div className="flex items-start justify-between gap-3">
              <JobName job={job} className="flex-1" />
              <FinishedLinkIcon link={job.finishedLink} className="-mr-1.5 -mt-1" />
            </div>
            <p className="truncate text-sm text-ink-secondary">
              {job.client.name} <span className="text-ink-muted">· {job.jobTypeName}</span>
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              <StageCell job={job} timeZone={timeZone} wrap />
              <SimpleDueChip due={job.due} active={job.stage.active} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <WaitingOn job={{ category: job.statusCategory, photographer: job.photographer, editor: job.editor }} viewerId={viewerId} />
              <EditorAvatar job={job} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
