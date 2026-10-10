import type { Metadata } from "next";
import { FilterX, Info, LayoutList, Plus } from "lucide-react";
import { FilterBar, JOB_FILTER_KEYS, SavedViewsBar } from "@/components/filters";
import { PageContainer } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { ColumnChooser, DEFAULT_ALL_WORK_COLUMNS, GroupByMenu, WorkTable, isWorkGroupBy, appliedSortOf, DEFAULT_WORK_SORT, toJobListInput, toQueryString } from "@/components/work-table";
import { safeListJobs } from "@/components/work-table/server";
import { pluralise } from "@/lib/utils";
import { allowed, pageContext } from "@/server/page";
import { listSavedViews } from "@/server/queries/views";
import { listJobTypes } from "@/server/queries/workflows";

export const metadata: Metadata = { title: "All Work" };

const ALL_WORK_QUICK_FILTERS = ["my_jobs", "unassigned", "overdue", "due_today", "due_this_week", "awaiting_review", "revision_required", "completed"] as const;
const COLUMN_STORAGE_KEY = "work-table:columns:all_work";

/**
 * All Work (spec §8, §19, §20, §38): every job the viewer may see, in one
 * Monday-style table. All state lives in the URL (filters, sort, grouping,
 * columns, saved view), so any view is a shareable link.
 */
export default async function AllWorkPage({ searchParams }: PageProps<"/workspace/all">) {
  const sp = await searchParams;
  const { ctx, db } = await pageContext();
  const timeZone = ctx.settings.timezone;

  const requested = toJobListInput(sp);
  // A saved view brings its own sort; otherwise default to workflow order.
  if (!requested.sort && !requested.viewId) requested.sort = DEFAULT_WORK_SORT;
  const { result, input, notice } = await safeListJobs(db, ctx, requested);
  const jobTypes = (await listJobTypes(db, ctx)).map((t) => ({ id: t.id, name: t.name, colour: t.colour }));
  const savedViews = await safeSavedViews(() => listSavedViews(db, ctx, { scope: "all_work" }));

  const canBulk = allowed(ctx, "job.bulk_reassign");
  const canOverride = allowed(ctx, "job.transition_override");
  const canShare = allowed(ctx, "saved_view.share");
  const canCreate = allowed(ctx, "job.create");

  const appliedGroup = result.applied.groupBy ?? null;
  const groupBy = isWorkGroupBy(appliedGroup) ? appliedGroup : null;
  const filtered = JOB_FILTER_KEYS.some((k) => sp[k] !== undefined && sp[k] !== "") || Boolean(sp.viewId);

  const description =
    ctx.role === "editor"
      ? "Every job you hold or have worked on, in one table."
      : ctx.role === "photographer"
        ? "Your jobs and your team's, in one sortable, filterable table."
        : "Every job in the studio — sort, filter, group and save views.";

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Workspace"
        title="All Work"
        description={description}
        meta={
          <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-ink-secondary numeric" title="Matching jobs">
            {result.total.toLocaleString("en-AU")}
          </span>
        }
        actions={
          canCreate ? (
            <Button href="/jobs/new" leadingIcon={<Plus aria-hidden="true" />}>
              New job
            </Button>
          ) : null
        }
      />

      <div className="flex flex-col gap-3">
        <SavedViewsBar scope="all_work" canShare={canShare} initialViews={savedViews ?? undefined} defaultColumns={DEFAULT_ALL_WORK_COLUMNS} />
        <FilterBar
          quickFilters={ALL_WORK_QUICK_FILTERS}
          timeZone={timeZone}
          options={{ jobTypes }}
          searchPlaceholder="Search jobs, clients, addresses, PJ-numbers…"
          trailing={
            <div className="flex items-center gap-2">
              <GroupByMenu />
              <ColumnChooser storageKey={COLUMN_STORAGE_KEY} defaults={DEFAULT_ALL_WORK_COLUMNS} />
            </div>
          }
        />
        {notice ? (
          <p role="status" className="flex items-center gap-2 rounded-md border border-info/25 bg-info-soft/60 px-3 py-2 text-sm text-info-fg">
            <Info aria-hidden="true" className="size-4 shrink-0" />
            {notice}
          </p>
        ) : null}
      </div>

      <WorkTable
        rows={result.rows}
        timeZone={timeZone}
        label="All work"
        columnStorageKey={COLUMN_STORAGE_KEY}
        defaultColumns={DEFAULT_ALL_WORK_COLUMNS}
        sortable
        appliedSort={appliedSortOf(result.applied.sort)}
        groupBy={groupBy}
        groups={result.groups}
        rowGroupKeys={result.rowGroupKeys}
        nextCursor={result.nextCursor}
        total={result.total}
        query={toQueryString(input)}
        selectable={canBulk}
        canOverride={canOverride}
        keyboard
        maxHeight="max(26rem, calc(100dvh - 14rem))"
        empty={
          filtered ? (
            <EmptyState
              icon={FilterX}
              title="No jobs match this view"
              description="Try a different quick filter, widen the search, or clear the filters to see everything you have access to."
              action={
                <Button href="/workspace/all" variant="outline">
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={LayoutList}
              title={ctx.role === "editor" ? "Nothing assigned to you yet" : "No jobs yet"}
              description={
                ctx.role === "editor"
                  ? "Jobs appear here as soon as they are assigned to you. Your queue lives in My Work."
                  : "Create the first job to start tracking shoots, edits, reviews and delivery in one place."
              }
              action={
                canCreate ? (
                  <Button href="/jobs/new" leadingIcon={<Plus aria-hidden="true" />}>
                    New job
                  </Button>
                ) : (
                  <Button href="/workspace/my" variant="outline">
                    Open My Work
                  </Button>
                )
              }
            />
          )
        }
      />
      <p className="sr-only" aria-live="polite">
        {pluralise(result.total, "job")} match the current view.
      </p>
    </PageContainer>
  );
}

/** Saved views are an enhancement: if they fail to load the bar fetches them itself. */
async function safeSavedViews<T>(fn: () => Promise<T> | T): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}
