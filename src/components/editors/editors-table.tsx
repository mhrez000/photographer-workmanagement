import Link from "next/link";
import { ChevronRight, UserPlus, WandSparkles } from "lucide-react";
import { PersonChip } from "@/components/jobs/person";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { EditorOverviewRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { NumberLabel } from "./number-label";
import { EDITOR_NUMBERS, formatOnDesk, formatRate } from "./numbers";

export interface EditorsTableProps {
  rows: EditorOverviewRow[];
  /** The viewer may invite people (owners / co-owners): the empty state offers it. */
  canInvite: boolean;
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
export function EditorsTable({ rows, canInvite }: EditorsTableProps) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={WandSparkles}
        title="No editors yet"
        description="Invite an editor and their jobs, late work and on-time record will show up here."
        action={
          canInvite ? (
            <Button href="/settings/people?invite=1" leadingIcon={<UserPlus aria-hidden="true" />}>
              Invite an editor
            </Button>
          ) : null
        }
      />
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
    </>
  );
}
