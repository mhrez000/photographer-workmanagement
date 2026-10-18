import Link from "next/link";
import { ChevronRight, MailQuestion, UserPlus, WandSparkles } from "lucide-react";
import { sharedNames } from "@/components/home/your-editors";
import { PersonChip } from "@/components/jobs/person";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { EditorOverviewRow, PendingEditor } from "@/lib/types";
import { cn } from "@/lib/utils";
import { NumberLabel } from "./number-label";
import { EDITOR_NUMBERS, formatOnDesk, formatRate } from "./numbers";

export interface EditorsTableProps {
  rows: EditorOverviewRow[];
  /** Invited editors who have not opened their link yet: listed greyed under the table, never counted. */
  pending?: PendingEditor[];
  /** The viewer may invite people (owners / co-owners): the empty state offers it. */
  canInvite: boolean;
}

/** "Invite pending · not joined yet" rows (front door): a ghost is never a row with numbers. */
function PendingEditors({ pending }: { pending: PendingEditor[] }) {
  if (pending.length === 0) return null;
  return (
    <ul className="divide-y divide-border border-t border-border bg-surface-sunken/40" aria-label="Invites pending" data-pending-editors="">
      {pending.map((p) => (
        <li key={p.id}>
          <Link href={`/settings/people/${encodeURIComponent(p.id)}`} className="flex flex-col gap-1 px-4 py-2.5 hover:bg-surface-muted focus-ring rounded-xs sm:flex-row sm:items-center sm:justify-between" data-pending-editor={p.id}>
            <span className="flex min-w-0 items-center gap-3">
              <Avatar name={p.name} size="sm" className="opacity-50 grayscale" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-ink-muted">{p.name}</span>
                <span className="block truncate text-xs text-ink-muted">{p.email}</span>
              </span>
            </span>
            <Badge variant="neutral" size="sm" className="shrink-0 self-start sm:self-auto">
              Invite pending · not joined yet
            </Badge>
          </Link>
        </li>
      ))}
    </ul>
  );
}

const [ON_DESK, LATE_NOW, FINISHED, ON_TIME, NEEDED_CHANGES] = EDITOR_NUMBERS;

function editorHref(id: string): string {
  return `/editors/${encodeURIComponent(id)}`;
}

/** "4 of 6" turns amber when the desk is full; "Late now" turns red above 0. */
function OnDeskValue({ row }: { row: EditorOverviewRow }) {
  return <span className={cn("numeric", row.full && "font-semibold text-attention-fg")}>{formatOnDesk(row.onDesk, row.usualCapacity)}</span>;
}

function LateValue({ row }: { row: EditorOverviewRow }) {
  return <span className={cn("numeric", row.lateNow > 0 && "font-semibold text-danger-fg")}>{row.lateNow}</span>;
}

function RateValue({ pct, notEnough }: { pct: number | null; notEnough: boolean }) {
  const text = formatRate(pct, notEnough);
  return <span className={cn(notEnough || pct === null ? "text-xs text-ink-subtle" : "numeric")}>{text}</span>;
}

/**
 * One row per editor, five numbers (docs/SIMPLIFICATION-PLAN.md §7). Rows arrive sorted "Late now" first.
 * A table from `md` up; stacked cards on phones. Clicking a row opens the editor's page.
 */
export function EditorsTable({ rows, pending = [], canInvite }: EditorsTableProps) {
  const duplicates = sharedNames([...rows.map((r) => r.editor.name), ...pending.map((p) => p.name)]);
  if (rows.length === 0) {
    return (
      <>
        <EmptyState
          icon={pending.length > 0 ? MailQuestion : WandSparkles}
          title={pending.length > 0 ? "No one has joined yet" : "No editors yet"}
          description={
            pending.length > 0
              ? "Your invite is out. Once they open their link and choose a password, their numbers appear here."
              : "Invite an editor and their jobs, late work and on-time record will show up here."
          }
          action={
            canInvite ? (
              <Button href="/settings/people?invite=editor" leadingIcon={<UserPlus aria-hidden="true" />}>
                {pending.length > 0 ? "Invite another editor" : "Invite an editor"}
              </Button>
            ) : null
          }
        />
        <PendingEditors pending={pending} />
      </>
    );
  }

  return (
    <>
      {/* Phones: one card per editor. */}
      <ul className="flex flex-col divide-y divide-border md:hidden">
        {rows.map((row) => (
          <li key={row.editor.id}>
            <Link href={editorHref(row.editor.id)} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-muted focus-ring rounded-xs">
              <div className="min-w-0 flex-1">
                <PersonChip user={row.editor} size="md" />
                {duplicates.has(row.editor.name.trim().toLowerCase()) ? <p className="mt-0.5 truncate text-xs text-ink-muted">{row.email}</p> : null}
                <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1.5 text-sm">
                  <div>
                    <dt className="text-2xs text-ink-muted">{ON_DESK.label}</dt>
                    <dd>
                      <OnDeskValue row={row} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-2xs text-ink-muted">{LATE_NOW.label}</dt>
                    <dd>
                      <LateValue row={row} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-2xs text-ink-muted">{FINISHED.label}</dt>
                    <dd className="numeric">{row.finished}</dd>
                  </div>
                  <div className="col-span-3 flex flex-wrap gap-x-4 gap-y-1 text-ink-secondary">
                    <span>
                      <span className="text-ink-muted">{ON_TIME.label}: </span>
                      <RateValue pct={row.onTimePct} notEnough={row.notEnough} />
                    </span>
                    <span>
                      <span className="text-ink-muted">{NEEDED_CHANGES.label}: </span>
                      <RateValue pct={row.neededChangesPct} notEnough={row.notEnough} />
                    </span>
                  </div>
                </dl>
              </div>
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-subtle" />
            </Link>
          </li>
        ))}
      </ul>

      {/* Laptops: the table. */}
      <div className="hidden md:block">
        <Table>
          <THead>
            <TR>
              <TH>Editor</TH>
              <TH numeric>
                <NumberLabel meta={ON_DESK} align="end" />
              </TH>
              <TH numeric>
                <NumberLabel meta={LATE_NOW} align="end" />
              </TH>
              <TH numeric>
                <NumberLabel meta={FINISHED} align="end" />
              </TH>
              <TH numeric>
                <NumberLabel meta={ON_TIME} align="end" />
              </TH>
              <TH numeric>
                <NumberLabel meta={NEEDED_CHANGES} align="end" />
              </TH>
              <TH shrink>
                <span className="sr-only">Open</span>
              </TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((row) => (
              <TR key={row.editor.id} interactive>
                <TD primary>
                  <PersonChip user={row.editor} href={editorHref(row.editor.id)} />
                  {duplicates.has(row.editor.name.trim().toLowerCase()) ? <span className="block truncate text-xs text-ink-muted">{row.email}</span> : null}
                </TD>
                <TD numeric>
                  <OnDeskValue row={row} />
                </TD>
                <TD numeric>
                  <LateValue row={row} />
                </TD>
                <TD numeric className="numeric">
                  {row.finished}
                </TD>
                <TD numeric>
                  <RateValue pct={row.onTimePct} notEnough={row.notEnough} />
                </TD>
                <TD numeric>
                  <RateValue pct={row.neededChangesPct} notEnough={row.notEnough} />
                </TD>
                <TD>
                  <Link href={editorHref(row.editor.id)} aria-label={`Open ${row.editor.name}`} className="inline-flex rounded-xs text-ink-subtle hover:text-ink focus-ring">
                    <ChevronRight aria-hidden="true" className="size-4" />
                  </Link>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
      <PendingEditors pending={pending} />
    </>
  );
}
