import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ChartCard } from "@/components/charts/chart-card";
import { SectionCard } from "@/components/common/section-card";
import { EditorActions, FiveNumbers, FinishedPerWeekChart, OnDeskList, PeriodSwitch, RecentlyFinished } from "@/components/editors";
import { PersonChip } from "@/components/jobs/person";
import { PageContainer } from "@/components/shell";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import type { EditorPickerOption } from "@/lib/types";
import { pluralise } from "@/lib/utils";
import { isAdmin } from "@/server/auth/permissions";
import { load, pageContext, param } from "@/server/page";
import { editorPickerOptions, getEditorDetail, parsePeriod } from "@/server/queries/editors";

export const metadata: Metadata = { title: "Editor" };

/** "On their desk now" shows at most this many jobs; the rest are one click away in Jobs (filtered to the editor). */
const ON_DESK_SHOWN = 10;

/**
 * One editor (docs/SIMPLIFICATION-PLAN.md §7): the same five numbers with vs-last-period arrows, what is
 * on their desk now (with Change editor), what they recently finished, finished per week, and
 * [Give them a job] [Move their jobs to…] [Edit person].
 */
export default async function EditorPage({ params, searchParams }: PageProps<"/editors/[id]">) {
  const { id: rawId } = await params;
  const sp = await searchParams;
  const { ctx, db } = await pageContext();
  const id = decodeURIComponent(rawId);
  const period = parsePeriod(param(sp, "period"));
  const detail = await load(() => getEditorDetail(db, ctx, id, { period }));
  const timeZone = ctx.settings.timezone;
  const admin = isAdmin(ctx);
  const canAssign = ctx.canAssignEditors;
  const options: EditorPickerOption[] = canAssign ? await load(() => editorPickerOptions(db, ctx)) : [];
  const onDesk = detail.onDeskNow.map(({ job }) => ({ id: job.id, version: job.version, name: job.name }));
  const weeksWithWork = detail.finishedPerWeek.filter((p) => p.finished > 0).length;
  // The desk list is capped so the chart stays within reach; the footer opens the whole list in Jobs.
  const deskShown = detail.onDeskNow.slice(0, ON_DESK_SHOWN);
  const deskMore = detail.onDeskNow.length - deskShown.length;

  return (
    <PageContainer>
      <PageHeader
        backHref="/editors"
        backLabel="Editors"
        title={
          <span className="flex flex-wrap items-center gap-3">
            <PersonChip user={detail.editor} size="md" />
            {!detail.editor.isActive ? <Badge variant="neutral">Deactivated</Badge> : null}
          </span>
        }
        description={
          detail.usualCapacity !== null
            ? `Usually handles up to ${pluralise(detail.usualCapacity, "job")} at a time${detail.full ? " · desk is full" : ""}.`
            : undefined
        }
        actions={<EditorActions editor={detail.editor} onDesk={onDesk} options={options} canAssign={canAssign} canEditPerson={admin} canCreateJobs={ctx.canCreateJobs} />}
      >
        <PeriodSwitch period={period} className="self-start" />
      </PageHeader>

      <FiveNumbers detail={detail} />

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard
          title="On their desk now"
          description={`${pluralise(detail.onDeskNow.length, "job")} · With editor and Changes asked`}
          flush
          footer={
            deskMore > 0 ? (
              <Link href={`/jobs?editorId=${encodeURIComponent(detail.editor.id)}`} className="inline-flex items-center gap-1 font-medium text-ink-secondary hover:text-ink focus-ring rounded-xs">
                See all {detail.onDeskNow.length} in Jobs
                <ArrowRight aria-hidden="true" className="size-3.5" />
              </Link>
            ) : undefined
          }
        >
          <OnDeskList jobs={deskShown} editorId={detail.editor.id} options={options} timeZone={timeZone} />
        </SectionCard>

        <SectionCard title="Recently finished" description="The last 20 jobs you approved, judged on when they first sent them for checking." flush>
          <RecentlyFinished jobs={detail.recentlyFinished} timeZone={timeZone} />
        </SectionCard>
      </div>

      <ChartCard
        title="Finished per week"
        takeaway={weeksWithWork === 0 ? undefined : `Jobs you approved, by the week they were approved · last ${detail.finishedPerWeek.length} weeks`}
        empty={weeksWithWork === 0}
        emptyMessage={`Nothing finished in the last ${detail.finishedPerWeek.length} weeks.`}
      >
        <FinishedPerWeekChart points={detail.finishedPerWeek} editorName={detail.editor.name} />
      </ChartCard>
    </PageContainer>
  );
}
