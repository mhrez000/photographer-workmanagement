import type { Metadata } from "next";
import { Download, History, SearchX, ShieldCheck } from "lucide-react";
import { ActivityFeed, ActivityFilters, compactQuery, eventGroupsFor, parseActivityPageFilters } from "@/components/activity";
import { JobLink } from "@/components/jobs/job-link";
import { PageContainer } from "@/components/shell/page-container";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Tooltip } from "@/components/ui/tooltip";
import type { JobRef } from "@/lib/types";
import { NotFoundError } from "@/server/errors";
import { listActivity } from "@/server/queries/activity";
import { getJobRowByNumber } from "@/server/queries/jobs";
import { listUsers } from "@/server/queries/users";
import { allowed, guard, load, pageContext } from "@/server/page";

export const metadata: Metadata = { title: "History" };

/**
 * Settings → History (docs/SIMPLIFICATION-PLAN.md §3): the studio-wide, permanent record of every change,
 * for the owner and co-owners. Same filters and CSV export as the old Activity page (which redirects here).
 */
export default async function HistoryPage({ searchParams }: PageProps<"/settings/history">) {
  const { ctx, db } = await pageContext();
  guard(ctx, "settings.view");
  guard(ctx, "activity.view_global");
  const sp = await searchParams;
  const tz = ctx.settings.timezone;
  const management = allowed(ctx, "activity.view_management_events");
  const groups = eventGroupsFor(management);
  const filters = parseActivityPageFilters(sp, tz, groups.map((g) => g.key));

  // A typed job number resolves to the job (only jobs the viewer can see).
  let job: JobRef | null = null;
  let jobMissing = false;
  if (filters.jobNumber && !filters.jobId) {
    try {
      const row = await getJobRowByNumber(db, ctx, filters.jobNumber);
      job = { id: row.id, jobNumber: row.jobNumber, name: row.name };
      filters.query.jobId = row.id;
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
      jobMissing = true;
    }
  }

  const query = compactQuery(filters.query);
  const page = jobMissing ? { items: [], nextCursor: null } : await load(() => listActivity(db, ctx, query));
  const users = await load(() => listUsers(db, ctx));
  const people: Record<string, string> = Object.fromEntries(users.map((u) => [u.id, u.name]));
  const canExport = allowed(ctx, "export.csv");

  const exportParams = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const val = Array.isArray(v) ? v.join(",") : v;
    if (val) exportParams.set(k, val);
  }
  const exportHref = `/activity/export${exportParams.size ? `?${exportParams}` : ""}`;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Settings"
        title="History"
        meta={
          <Tooltip content="Every change is written down when it happens and can never be edited or deleted, not even by the owner.">
            <Badge variant="outline" size="sm" className="gap-1" tabIndex={0}>
              <ShieldCheck aria-hidden="true" className="size-3 text-success" />
              Permanent record
            </Badge>
          </Tooltip>
        }
        description="Everything that happened across the studio: who did what, when, and what it was before."
        actions={
          canExport ? (
            <a href={exportHref} download className={buttonVariants({ variant: "outline", size: "sm" })}>
              <Download aria-hidden="true" />
              Download CSV
            </a>
          ) : null
        }
      >
        <ActivityFilters
          timeZone={tz}
          groups={groups.map(({ key, label, description }) => ({ key, label, description }))}
          people={users.map((u) => ({ id: u.id, name: u.name, colour: u.avatarColour, isActive: u.isActive, role: u.role }))}
        />
      </PageHeader>

      {job || filters.rangeLabel ? (
        <p className="-mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-muted">
          {job ? (
            <>
              <span>Showing the history of</span>
              <JobLink job={job} />
              <Button href={`/jobs/${job.id}`} variant="link" size="sm">
                Open the job
              </Button>
            </>
          ) : null}
          {filters.rangeLabel ? (
            <span className="numeric">
              {job ? "· " : ""}
              {filters.rangeLabel}
            </span>
          ) : null}
        </p>
      ) : null}

      <Card className="px-4 py-2 sm:px-5">
        {jobMissing ? (
          <EmptyState
            icon={SearchX}
            title={`No job ${filters.jobNumber} that you can see`}
            description="Check the number (it looks like PJ-0042), or clear the job filter to see everything."
            action={
              <Button href="/settings/history" variant="outline" size="sm">
                Clear filters
              </Button>
            }
          />
        ) : (
          <ActivityFeed
            key={JSON.stringify(query)}
            initialItems={page.items}
            initialCursor={page.nextCursor}
            query={query}
            timeZone={tz}
            people={people}
            empty={
              filters.active ? (
                <EmptyState
                  icon={SearchX}
                  title="Nothing matches these filters"
                  description="Try a wider date range, another person, or fewer kinds of change."
                  action={
                    <Button href="/settings/history" variant="outline" size="sm">
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={History}
                  title="Nothing yet"
                  description="As jobs are created, given to editors, checked and finished, every step lands here, for good."
                  action={
                    allowed(ctx, "job.create") ? (
                      <Button href="/jobs/new" size="sm">
                        Create a job
                      </Button>
                    ) : undefined
                  }
                />
              )
            }
          />
        )}
      </Card>
    </PageContainer>
  );
}
