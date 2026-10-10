import type { Metadata } from "next";
import { Download, History, SearchX, ShieldCheck } from "lucide-react";
import { ActivityFeed, ActivityFilters, compactQuery, eventGroupsFor, parseActivityPageFilters } from "@/components/activity";
import { PageContainer } from "@/components/shell";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Tooltip } from "@/components/ui/tooltip";
import { PageHeader } from "@/components/ui/page-header";
import { JobLink } from "@/components/jobs/job-link";
import type { JobRef } from "@/lib/types";
import { allowed, guard, load, pageContext } from "@/server/page";
import { listActivity } from "@/server/queries/activity";
import { getJobRowByNumber } from "@/server/queries/jobs";
import { listUsers } from "@/server/queries/users";
import { NotFoundError } from "@/server/errors";

export const metadata: Metadata = { title: "Activity" };

export default async function ActivityPage({ searchParams }: PageProps<"/activity">) {
  const { ctx, db } = await pageContext();
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
        eyebrow="Activity log"
        title="Activity"
        meta={
          <Tooltip content="Every change is recorded when it happens and can never be edited or deleted — not even by an owner.">
            <Badge variant="outline" size="sm" className="gap-1" tabIndex={0}>
              <ShieldCheck aria-hidden="true" className="size-3 text-success" />
              Audit · append-only
            </Badge>
          </Tooltip>
        }
        description={
          management
            ? "Everything that happened across the studio: who did what, when, and what it was before."
            : "Changes on the jobs you can see, plus your own actions."
        }
        actions={
          canExport ? (
            <a href={exportHref} download className={buttonVariants({ variant: "outline", size: "sm" })}>
              <Download aria-hidden="true" />
              Export CSV
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
              <Button href={`/jobs/${job.id}?tab=history`} variant="link" size="sm">
                Open job history
              </Button>
            </>
          ) : null}
          {filters.rangeLabel ? <span className="numeric">{job ? "· " : ""}{filters.rangeLabel}</span> : null}
        </p>
      ) : null}

      <Card className="px-4 py-2 sm:px-5">
        {jobMissing ? (
          <EmptyState
            icon={SearchX}
            title={`No job ${filters.jobNumber} that you can see`}
            description="Check the number (it looks like PJ-0042), or clear the job filter to see all activity."
            action={
              <Button href="/activity" variant="outline" size="sm">
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
                  description="Try a wider date range, another person, or fewer event types."
                  action={
                    <Button href="/activity" variant="outline" size="sm">
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={History}
                  title="No activity yet"
                  description="As jobs are created, assigned, edited and delivered, every step lands here — permanently."
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
