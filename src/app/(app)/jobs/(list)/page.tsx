import type { Metadata } from "next";
import { Briefcase, Plus, SearchX } from "lucide-react";
import {
  JobsFilters,
  JobsPagination,
  JobsTable,
  MonthCalendar,
  StageTabs,
  hasFilters,
  jobsHref,
  monthGridRange,
  monthOf,
  normaliseMonth,
  parseJobsUrl,
  type FilterOption,
} from "@/components/jobs-list";
import { PageContainer } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { todayCivil } from "@/lib/dates";
import { STAGE_META } from "@/lib/stages";
import type { SimpleCalendarEvent, StageFilter } from "@/lib/types";
import { ForbiddenError } from "@/server/errors";
import { allowed, load, pageContext } from "@/server/page";
import { SIMPLE_LIST_DEFAULT_LIMIT, calendarJobs, listJobsByStage, stageCounts } from "@/server/queries/jobsSimple";
import { decodeOffsetCursor, encodeOffsetCursor } from "@/server/queries/jobs";
import { getClientOptions, getUserOptions } from "@/server/queries/options";
import { loadOrgSettingsRow } from "@/server/queries/scope";

export const metadata: Metadata = { title: "Jobs" };

const EMPTY_COPY: Record<StageFilter, { title: string; description: string }> = {
  all_active: { title: "No active jobs", description: "Every job is done. Create the next one when you have shot it." },
  needs_editor: { title: "Nothing needs an editor", description: "Every shot job has an editor." },
  with_editor: { title: "Nothing is with an editor", description: "Jobs you give to an editor sit here until they send them back for checking." },
  ready_to_check: { title: "Nothing to check", description: "When an editor sends finished photos, they land here." },
  changes_asked: { title: "No changes asked", description: "Jobs you send back to an editor sit here until they return." },
  done: { title: "Nothing finished yet", description: "Approved jobs appear here." },
  cancelled: { title: "No cancelled jobs", description: "Cancelled jobs can be restored from their page." },
};

/** Filter options, or none when the viewer may not list people / clients (the control is then hidden). */
async function safeOptions<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ForbiddenError) return [];
    throw err;
  }
}

/** The List / Calendar search, editor and client filters applied to calendar events in memory. */
function filterEvents(events: SimpleCalendarEvent[], f: { q: string; editorId: string; clientId: string }): SimpleCalendarEvent[] {
  const q = f.q.toLowerCase();
  return events.filter((e) => {
    const j = e.job;
    if (f.clientId && j.client.id !== f.clientId) return false;
    if (f.editorId === "none" ? j.editor !== null : f.editorId && j.editor?.id !== f.editorId) return false;
    if (!q) return true;
    return [j.name, j.jobNumber, j.client.name, j.project.name, j.project.address ?? ""].some((s) => s.toLowerCase().includes(q));
  });
}

/**
 * /jobs — the ONE list of jobs (docs/SIMPLIFICATION-PLAN.md §1, §3, §4, §8). Stage tabs with
 * counts, Late and Show cancelled, Search / Editor / Client, and a List / Calendar switch.
 * Who you are decides which jobs you see (the queries scope by `visibleJobsWhere`), never which
 * page you open. No saved views, group-by, column chooser or bulk actions (Advanced only).
 */
export default async function JobsPage({ searchParams }: PageProps<"/jobs">) {
  const sp = await searchParams;
  const { ctx, db } = await pageContext();
  const timeZone = ctx.settings.timezone;
  const state = parseJobsUrl(sp);
  const canCreate = allowed(ctx, "job.create");
  const filterInput = { q: state.q || undefined, editorId: state.editorId || undefined, clientId: state.clientId || undefined };

  const counts = await load(() => stageCounts(db, ctx, filterInput));
  const editors: FilterOption[] = (await safeOptions(() => getUserOptions(db, ctx, { role: "editor" }))).map((u) => ({ value: u.id, label: u.name }));
  const clients: FilterOption[] = (await safeOptions(() => getClientOptions(db, ctx))).map((c) => ({ value: c.id, label: c.name }));

  const filters = (
    <JobsFilters state={state} editors={editors} clients={clients} lateCount={counts.late} cancelledCount={counts.cancelled} hideStageFilters={state.view === "calendar"} />
  );
  // Phones already carry the (+) tab (plan §3), so the header button is for larger screens.
  const newJob = canCreate ? (
    <Button href="/jobs/new" leadingIcon={<Plus aria-hidden="true" />} className="hidden sm:inline-flex">
      New job
    </Button>
  ) : null;

  /* ---------------- Calendar view ---------------- */
  if (state.view === "calendar") {
    const today = todayCivil(timeZone);
    const month = normaliseMonth(state.month, monthOf(today));
    const weekStartsOn = (await load(() => loadOrgSettingsRow(db, ctx)))?.weekStartsOn ?? 1;
    const range = monthGridRange(month, weekStartsOn);
    const events = filterEvents(await load(() => calendarJobs(db, ctx, range)), state);
    return (
      <PageContainer>
        <PageHeader title="Jobs" description="Shoot dates and due dates, month by month. The calendar shows every active job, so the stage tabs and the Late filter sit this one out." actions={newJob} />
        {filters}
        <MonthCalendar events={events} month={month} today={today} weekStartsOn={weekStartsOn} hrefForMonth={(m) => jobsHref(state, { month: m, cursor: undefined })} />
      </PageContainer>
    );
  }

  /* ---------------- List view ---------------- */
  const limit = SIMPLE_LIST_DEFAULT_LIMIT;
  const offset = decodeOffsetCursor(state.cursor);
  const result = await load(() => listJobsByStage(db, ctx, { stage: state.stage, late: state.late, showCancelled: state.showCancelled, cursor: state.cursor, limit, ...filterInput }));
  const filtered = hasFilters(state);
  const nothingAtAll = !filtered && state.stage === "all_active" && result.total === 0 && Object.values(counts.byStage).every((n) => n === 0);
  const copy = EMPTY_COPY[state.stage];
  const prevHref = offset > 0 ? jobsHref(state, { cursor: offset - limit > 0 ? encodeOffsetCursor(offset - limit) : undefined }) : null;
  const nextHref = result.nextCursor ? jobsHref(state, { cursor: result.nextCursor }) : null;

  return (
    <PageContainer>
      <PageHeader title="Jobs" description="Every job, by stage. Each one says who it's waiting on." actions={newJob}>
        <StageTabs state={state} counts={counts} />
      </PageHeader>
      {filters}

      {result.rows.length === 0 ? (
        nothingAtAll ? (
          <EmptyState
            bordered
            icon={Briefcase}
            title="No jobs yet"
            description="Shoot, give it to an editor, check it, done. Create your first job to get going."
            action={
              canCreate ? (
                <Button href="/jobs/new" leadingIcon={<Plus aria-hidden="true" />}>
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
            description={`Nothing in ${state.stage === "all_active" ? "All active" : STAGE_META[state.stage].label} matches these filters.`}
            action={
              <Button variant="outline" href={jobsHref({ stage: state.stage })}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState bordered icon={Briefcase} title={copy.title} description={copy.description} />
        )
      ) : (
        <>
          <JobsTable rows={result.rows} timeZone={timeZone} viewerId={ctx.userId} />
          <JobsPagination shown={result.rows.length} offset={offset} total={result.total} prevHref={prevHref} nextHref={nextHref} />
        </>
      )}
    </PageContainer>
  );
}
