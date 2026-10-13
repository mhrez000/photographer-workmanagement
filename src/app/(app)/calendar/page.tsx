import type { Metadata } from "next";
import { MonthCalendar, monthGridRange, monthOf, normaliseMonth } from "@/components/jobs-list";
import { PageContainer } from "@/components/shell";
import { PageHeader } from "@/components/ui/page-header";
import { todayCivil } from "@/lib/dates";
import { load, pageContext, param } from "@/server/page";
import { calendarJobs } from "@/server/queries/jobsSimple";
import { loadOrgSettingsRow } from "@/server/queries/scope";

export const metadata: Metadata = { title: "Calendar" };

/**
 * /calendar — the editor's own due dates, month by month (docs/SIMPLIFICATION-PLAN.md §3).
 * The query scopes to the jobs given to this editor; only active jobs have a due date here.
 * URL state: ?month=YYYY-MM.
 */
export default async function CalendarPage({ searchParams }: PageProps<"/calendar">) {
  const sp = await searchParams;
  const { ctx, db } = await pageContext();
  const timeZone = ctx.settings.timezone;
  const today = todayCivil(timeZone);
  const month = normaliseMonth(param(sp, "month"), monthOf(today));
  const weekStartsOn = (await load(() => loadOrgSettingsRow(db, ctx)))?.weekStartsOn ?? 1;
  const range = monthGridRange(month, weekStartsOn);
  const events = await load(() => calendarJobs(db, ctx, range));
  const dueCount = events.filter((e) => e.kind === "due" && e.civilDate.startsWith(month)).length;

  return (
    <PageContainer>
      <PageHeader
        title="Calendar"
        description={dueCount === 0 ? "Your due dates, month by month." : `${dueCount} ${dueCount === 1 ? "job is" : "jobs are"} due this month.`}
      />
      <MonthCalendar events={events} month={month} today={today} weekStartsOn={weekStartsOn} kinds={["due"]} hrefForMonth={(m) => `/calendar?month=${m}`} />
    </PageContainer>
  );
}
