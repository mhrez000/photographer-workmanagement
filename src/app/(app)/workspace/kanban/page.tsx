import type { Metadata } from "next";
import { Briefcase, Plus, SearchX } from "lucide-react";
import { JobsFilters, jobsHref, parseJobsUrl, type FilterOption } from "@/components/jobs-list";
import { KanbanBoard } from "@/components/kanban/kanban-board";
import { BOARD_STAGES, kanbanLimitKey, type BoardColumnKey } from "@/components/kanban/shared";
import { PageContainer } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { ForbiddenError } from "@/server/errors";
import { advancedPageContext, allowed, load, param } from "@/server/page";
import { stageCounts } from "@/server/queries/jobsSimple";
import { getStageBoard, STAGE_BOARD_DEFAULT_PER_COLUMN, STAGE_BOARD_MAX_PER_COLUMN } from "@/server/queries/kanban";
import { getClientOptions, getUserOptions } from "@/server/queries/options";

export const metadata: Metadata = { title: "Board" };

const BOARD_PATH = "/workspace/kanban";
/** Cards per column on first render; "Show more" adds another page via `?more_<stage>=`. */
const PAGE_SIZE = STAGE_BOARD_DEFAULT_PER_COLUMN;

/** Filter options, or none when the viewer may not list people / clients (the control is then hidden). */
async function safeOptions<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ForbiddenError) return [];
    throw err;
  }
}

/**
 * /workspace/kanban — the Board, an Advanced tool (docs/SIMPLIFICATION-PLAN.md §8): the five
 * stages as columns, the same filters as Jobs, and a drag that opens the same button you would
 * press on the job page. Who you are decides which jobs you see (`visibleJobsWhere`); every
 * drop is one of the simple actions, re-checked by its service.
 */
export default async function KanbanPage({ searchParams }: PageProps<"/workspace/kanban">) {
  const sp = await searchParams;
  const { ctx, db } = await advancedPageContext("kanban", "/jobs"); // Advanced gate before any query (see src/server/page.ts)
  const timeZone = ctx.settings.timezone;
  const state = parseJobsUrl(sp);
  const canCreate = allowed(ctx, "job.create");
  const filterInput = { q: state.q || undefined, editorId: state.editorId || undefined, clientId: state.clientId || undefined };

  const columnKeys: BoardColumnKey[] = [...BOARD_STAGES, "cancelled"];
  const limits = Object.fromEntries(
    columnKeys.map((c) => {
      const n = Number(param(sp, kanbanLimitKey(c)));
      return [c, Number.isFinite(n) && n > PAGE_SIZE ? Math.min(Math.floor(n), STAGE_BOARD_MAX_PER_COLUMN) : PAGE_SIZE];
    }),
  ) as Record<BoardColumnKey, number>;
  const maxLimit = Math.max(...Object.values(limits));

  const board = await load(() => getStageBoard(db, ctx, { ...filterInput, late: state.late, showCancelled: state.showCancelled, perColumnLimit: maxLimit }));
  const counts = await load(() => stageCounts(db, ctx, filterInput));
  const editors: FilterOption[] = (await safeOptions(() => getUserOptions(db, ctx, { role: "editor" }))).map((u) => ({ value: u.id, label: u.name }));
  const clients: FilterOption[] = (await safeOptions(() => getClientOptions(db, ctx))).map((c) => ({ value: c.id, label: c.name }));

  // One query at the largest requested limit; each column is trimmed back to its own limit.
  const columns = board.columns.map((c) => ({ ...c, cards: c.cards.slice(0, limits[c.stage]) }));
  const cancelled = board.cancelled ? { ...board.cancelled, cards: board.cancelled.cards.slice(0, limits.cancelled) } : null;

  const total = columns.reduce((n, c) => n + c.count, 0) + (cancelled?.count ?? 0);
  const filtered = Boolean(state.q || state.editorId || state.clientId || state.late);
  const nothingAtAll = !filtered && total === 0 && Object.values(counts.byStage).every((n) => n === 0);

  return (
    <PageContainer width="full" className="max-w-[2200px]">
      <PageHeader
        eyebrow="Advanced"
        title="Board"
        description="Your jobs in their five stages. Drag a card to its next stage and the same button you would press on the job page opens — Assign editor, Send for checking, Approve, Ask for changes or Reopen."
        actions={
          canCreate ? (
            <Button href="/jobs/new" leadingIcon={<Plus aria-hidden="true" className="size-4" />} className="hidden sm:inline-flex">
              New job
            </Button>
          ) : null
        }
      >
        <JobsFilters state={state} editors={editors} clients={clients} lateCount={counts.late} cancelledCount={counts.cancelled} hideViewSwitch />
      </PageHeader>

      {total === 0 ? (
        nothingAtAll ? (
          <EmptyState
            bordered
            icon={Briefcase}
            title="No jobs yet"
            description="Shoot, give it to an editor, check it, done. Create your first job and it lands in Needs editor."
            action={
              canCreate ? (
                <Button href="/jobs/new" leadingIcon={<Plus aria-hidden="true" className="size-4" />}>
                  Create your first job
                </Button>
              ) : null
            }
          />
        ) : filtered ? (
          <EmptyState
            bordered
            icon={SearchX}
            title="No jobs match"
            description="Nothing on the board matches these filters."
            action={
              <Button variant="outline" href={jobsHref({}, {}, BOARD_PATH)}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState bordered icon={Briefcase} title="No active jobs" description="Every job is done. Create the next one when you have shot it." />
        )
      ) : (
        <KanbanBoard columns={columns} cancelled={cancelled} viewerId={board.viewerId} asOf={board.asOf} timeZone={timeZone} pageSize={PAGE_SIZE} />
      )}
    </PageContainer>
  );
}
