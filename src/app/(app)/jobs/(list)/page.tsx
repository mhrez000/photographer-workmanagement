import type { Metadata } from "next";
import { Briefcase, FilterX, Info, Plus } from "lucide-react";
import { FilterBar, QUICK_FILTER_LABELS, QUICK_FILTER_TONES } from "@/components/filters";
import { PageContainer } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { JOBS_LIST_COLUMNS, QuickTabs, WorkTable, appliedSortOf, DEFAULT_WORK_SORT, toJobListInput, toQueryString, type QuickTab } from "@/components/work-table";
import { safeListJobs } from "@/components/work-table/server";
import { QUICK_FILTERS, type QuickFilter } from "@/lib/constants";
import { allowed, pageContext } from "@/server/page";
import { listJobs } from "@/server/queries/jobs";

export const metadata: Metadata = { title: "Jobs" };

const TABS: readonly (QuickFilter | "all")[] = ["all", "my_jobs", "unassigned", "overdue", "due_today", "due_this_week", "awaiting_review", "revision_required", "completed"];

function isQuick(value: string | undefined): value is QuickFilter {
  return !!value && (QUICK_FILTERS as readonly string[]).includes(value);
}

/**
 * Jobs (ARCHITECTURE §10): a lighter list than All Work — quick-filter tabs
 * with live counts, search and a few facets, same rows and cards.
 */
export default async function JobsPage({ searchParams }: PageProps<"/jobs">) {
  const sp = await searchParams;
  const { ctx, db } = await pageContext();
  const timeZone = ctx.settings.timezone;
  const canCreate = allowed(ctx, "job.create");

  const rawQuick = typeof sp.quick === "string" ? sp.quick.split(",")[0] : undefined;
  const activeTab: QuickFilter | "all" = isQuick(rawQuick) && TABS.includes(rawQuick) ? rawQuick : "all";

  const requested = toJobListInput(sp, { quick: activeTab === "all" ? undefined : activeTab });
  if (!requested.sort && !requested.viewId) requested.sort = DEFAULT_WORK_SORT;
  const { result, input, notice } = safeListJobs(db, ctx, requested);

  // Counts per tab share every other filter (search, facets).
  const base: Record<string, string> = { ...input };
  delete base.quick;
  delete base.sort;
  delete base.groupBy;
  const tabs: QuickTab[] = TABS.map((tab) => {
    let count: number | null = null;
    try {
      count = listJobs(db, ctx, { ...base, ...(tab === "all" ? {} : { quick: tab }), limit: "1" }).total;
    } catch {
      count = null;
    }
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (k === "quick" || k === "cursor" || v === undefined) continue;
      params.set(k, Array.isArray(v) ? v.join(",") : v);
    }
    if (tab !== "all") params.set("quick", tab);
    const qs = params.toString();
    return {
      key: tab,
      label: tab === "all" ? "All" : QUICK_FILTER_LABELS[tab],
      href: qs ? `/jobs?${qs}` : "/jobs",
      count,
      active: tab === activeTab,
      tone: tab === "all" ? undefined : QUICK_FILTER_TONES[tab],
    };
  });

  const searching = Boolean(input.q || input.editorId || input.clientId || input.priority);
  const tabLabel = activeTab === "all" ? null : QUICK_FILTER_LABELS[activeTab].toLowerCase();

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Production"
        title="Jobs"
        description="Every job you can see, filtered the way you work."
        actions={
          canCreate ? (
            <Button href="/jobs/new" leadingIcon={<Plus aria-hidden="true" />}>
              New job
            </Button>
          ) : null
        }
      >
        <QuickTabs tabs={tabs} label="Quick filters" />
      </PageHeader>

      <div className="flex flex-col gap-3">
        <FilterBar quickFilters={[]} facets={["editor", "client", "priority"]} searchPlaceholder="Search jobs, clients, PJ-numbers…" />
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
        label={tabLabel ? `Jobs: ${tabLabel}` : "Jobs"}
        columns={JOBS_LIST_COLUMNS}
        sortable
        appliedSort={appliedSortOf(result.applied.sort)}
        nextCursor={result.nextCursor}
        total={result.total}
        query={toQueryString(input)}
        keyboard
        empty={
          searching || activeTab !== "all" ? (
            <EmptyState
              icon={FilterX}
              title={tabLabel && !searching ? `No ${tabLabel} jobs` : "No jobs match"}
              description={
                activeTab === "overdue" && !searching
                  ? "Nothing is overdue. Nice work."
                  : "Try another tab, or clear the search and filters to see every job you have access to."
              }
              action={
                <Button href="/jobs" variant="outline">
                  Show all jobs
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Briefcase}
              title="No jobs yet"
              description={canCreate ? "Create a job to start tracking the shoot, edit, review and delivery." : "Jobs you are assigned to will appear here."}
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
    </PageContainer>
  );
}
