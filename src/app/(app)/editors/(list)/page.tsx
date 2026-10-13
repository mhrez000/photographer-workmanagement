import type { Metadata } from "next";
import { Download } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { EditorsTable, ExtraPhotographersTable, OnTimeNote, PeriodSwitch, WaitingOnYou } from "@/components/editors";
import { PageContainer } from "@/components/shell";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { isAdmin } from "@/server/auth/permissions";
import { load, pageContext, param } from "@/server/page";
import { getEditorsOverview, parsePeriod } from "@/server/queries/editors";

export const metadata: Metadata = { title: "Editors" };

/**
 * Editors (docs/SIMPLIFICATION-PLAN.md §7): the one page that replaces Team Work, Team → Editors,
 * Workloads, Performance, Photographers, Analytics, Reports and Bottlenecks. The 403 gate lives in
 * `../layout.tsx`; `getEditorsOverview` re-checks.
 */
export default async function EditorsPage({ searchParams }: PageProps<"/editors">) {
  const sp = await searchParams;
  const { ctx, db } = await pageContext();
  const period = parsePeriod(param(sp, "period"));
  const overview = await load(() => getEditorsOverview(db, ctx, { period }));
  const csvHref = `/api/editors.csv?period=${period}`;

  return (
    <PageContainer>
      <PageHeader
        title="Editors"
        description="Who has what, what is late, and how each editor is doing — in five plain numbers."
        actions={
          <>
            <PeriodSwitch period={period} />
            <a href={csvHref} download className={buttonVariants({ variant: "outline", size: "md" })}>
              <Download aria-hidden="true" />
              Download CSV
            </a>
          </>
        }
      />

      <WaitingOnYou count={overview.waitingOnYou.count} oldestAgeSeconds={overview.waitingOnYou.oldestAgeSeconds} />

      <OnTimeNote />

      <SectionCard title="Your editors" description={`${overview.period.label} · sorted with late work first`} flush>
        <EditorsTable rows={overview.rows} canInvite={isAdmin(ctx)} />
      </SectionCard>

      {overview.extraPhotographers.length > 0 ? (
        <SectionCard title="Extra photographers" description="Their shoots, the edits waiting for their check, and anything late on their jobs." flush>
          <ExtraPhotographersTable rows={overview.extraPhotographers} periodLabel={overview.period.label} />
        </SectionCard>
      ) : null}
    </PageContainer>
  );
}
