import type { Metadata } from "next";
import { Plus, SquareKanban } from "lucide-react";
import { FilterBar } from "@/components/filters/filter-bar";
import { KanbanBoard } from "@/components/kanban/kanban-board";
import { kanbanLimitKey } from "@/components/kanban/shared";
import { ShowCancelledToggle } from "@/components/kanban/kanban-controls";
import { PageContainer } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { KANBAN_COLUMNS, type QuickFilter } from "@/lib/constants";
import { allowed, load, pageContext, param, params } from "@/server/page";
import { getKanbanBoard, KANBAN_MAX_PER_COLUMN } from "@/server/queries/kanban";

export const metadata: Metadata = { title: "Kanban" };

/** Cards per column on first render; "Show more" adds another page via `?more_<column>=`. */
const PAGE_SIZE = 40;
const QUICK: readonly QuickFilter[] = ["my_jobs", "unassigned", "overdue", "due_today", "due_this_week", "paused"];
const FILTER_KEYS = ["q", "quick", "editorId", "photographerId", "clientId", "jobTypeId", "priority"] as const;

/**
 * /workspace/kanban — the production board (spec §9, ARCHITECTURE §4.6, §10).
 * Every role may open it; rows are scoped by `visibleJobsWhere` in the query,
 * and every drop is re-authorised by the workflow engine.
 */
export default async function KanbanPage({ searchParams }: PageProps<"/workspace/kanban">) {
  const sp = await searchParams;
  const { ctx, db } = await pageContext();
  const timeZone = ctx.settings.timezone;

  const includeCancelled = param(sp, "includeCancelled") === "1";
  const limits = Object.fromEntries(
    [...KANBAN_COLUMNS, "cancelled" as const].map((c) => {
      const n = Number(param(sp, kanbanLimitKey(c)));
      return [c, Number.isFinite(n) && n > PAGE_SIZE ? Math.min(Math.floor(n), KANBAN_MAX_PER_COLUMN) : PAGE_SIZE];
    }),
  ) as Record<(typeof KANBAN_COLUMNS)[number] | "cancelled", number>;
  const maxLimit = Math.max(...Object.values(limits));

  const filters = {
    q: param(sp, "q"),
    quick: params(sp, "quick"),
    editorId: params(sp, "editorId"),
    photographerId: params(sp, "photographerId"),
    clientId: params(sp, "clientId"),
    jobTypeId: params(sp, "jobTypeId"),
    priority: params(sp, "priority"),
  };
  const board = load(() => getKanbanBoard(db, ctx, { ...filters, includeCancelled, perColumnLimit: maxLimit }));

  // One query at the largest requested limit; each column is trimmed back to its own limit.
  const columns = board.columns.map((c) => ({ ...c, cards: c.cards.slice(0, limits[c.column]) }));
  const cancelled = board.cancelled ? { ...board.cancelled, cards: board.cancelled.cards.slice(0, limits.cancelled) } : null;

  const total = columns.reduce((n, c) => n + c.count, 0) + (cancelled?.count ?? 0);
  const filtered = FILTER_KEYS.some((k) => sp[k] !== undefined && sp[k] !== "");
  const canCreate = allowed(ctx, "job.create");

  return (
    <PageContainer width="full" className="max-w-[2200px]">
      <PageHeader
        eyebrow="Workspace"
        title="Kanban"
        description="Drag a job to move it through the workflow. Every move is checked against your permissions and recorded in the job history."
        actions={
          canCreate ? (
            <Button href="/jobs/new" leadingIcon={<Plus aria-hidden="true" className="size-4" />}>
              New job
            </Button>
          ) : null
        }
      >
        <FilterBar
          quickFilters={QUICK}
          facets={["editor", "photographer", "client", "priority"]}
          searchPlaceholder="Filter the board…"
          trailing={<ShowCancelledToggle />}
        />
      </PageHeader>

      {total === 0 ? (
        filtered ? (
          <EmptyState
            bordered
            icon={SquareKanban}
            title="No jobs match these filters"
            description="Try removing a filter or clearing the search to see the whole board."
            action={
              <Button variant="outline" href="/workspace/kanban">
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            bordered
            icon={SquareKanban}
            title="The board is empty"
            description={
              canCreate
                ? "Create a job and it will appear in the New column, ready to assign to an editor."
                : "Jobs assigned to you will appear here as they move through editing and review."
            }
            action={
              canCreate ? (
                <Button href="/jobs/new" leadingIcon={<Plus aria-hidden="true" className="size-4" />}>
                  Create a job
                </Button>
              ) : null
            }
          />
        )
      ) : (
        <KanbanBoard columns={columns} cancelled={cancelled} asOf={board.asOf} timeZone={timeZone} pageSize={PAGE_SIZE} />
      )}
    </PageContainer>
  );
}
