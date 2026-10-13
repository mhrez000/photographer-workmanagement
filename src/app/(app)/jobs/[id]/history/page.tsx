import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { HistoryTab } from "@/components/job-detail";
import { PageContainer } from "@/components/shell";
import { PageHeader } from "@/components/ui/page-header";
import { StagePill } from "@/components/jobs/stage-pill";
import { NotFoundError } from "@/server/errors";
import { load, pageContext } from "@/server/page";
import { getJobHistory } from "@/server/queries/jobHistory";
import { getJobRowByNumber, getJobRowsByIds } from "@/server/queries/jobs";

export const metadata: Metadata = { title: "Full history" };

const JOB_NUMBER = /^[A-Za-z]{1,8}-\d{1,8}$/;

/**
 * Full history (docs/SIMPLIFICATION-PLAN.md §5 "Who did what → Full history"):
 * the complete, permanent audit log of one job. The old `?tab=history` and
 * `?view=history` addresses land here.
 */
export default async function JobHistoryPage({ params }: PageProps<"/jobs/[id]/history">) {
  const { id: rawId } = await params;
  const { ctx, db } = await pageContext();
  const id = decodeURIComponent(rawId);

  if (JOB_NUMBER.test(id)) {
    try {
      const row = await getJobRowByNumber(db, ctx, id);
      redirect(`/jobs/${row.id}/history`);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
  }

  const row = (await getJobRowsByIds(db, ctx, [id]))[0];
  if (!row) notFound();
  const entries = await load(() => getJobHistory(db, ctx, row.id));
  const tz = ctx.settings.timezone;

  return (
    <PageContainer>
      <PageHeader
        backHref={`/jobs/${row.id}`}
        backLabel={`Back to ${row.name}`}
        eyebrow={<span className="font-mono numeric">{row.jobNumber}</span>}
        title="Full history"
        meta={<StagePill job={{ category: row.statusCategory, revisionCount: row.revisionCount }} size="md" hideSubLabel />}
        description="Every change to this job, by everyone, in order. Nothing here can be edited or removed."
      />
      <HistoryTab entries={entries} timeZone={tz} current={row.status} />
    </PageContainer>
  );
}
