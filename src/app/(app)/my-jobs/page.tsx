import type { Metadata } from "next";
import { ListChecks } from "lucide-react";
import { CardGrid, JobSection, MyJobCardView, NextUp, ThisMonthFooter, type MyJobCardKind } from "@/components/my-jobs";
import { PageContainer } from "@/components/shell";
import { EmptyState } from "@/components/ui/empty-state";
import type { MyJobCard } from "@/lib/types";
import { load, pageContext } from "@/server/page";
import { getMyJobs } from "@/server/queries/myJobs";

export const metadata: Metadata = { title: "My jobs" };

/** "Waiting for Mo to check" when every waiting job has the same checker; otherwise "Waiting to be checked". */
function waitingTitle(cards: MyJobCard[]): string {
  const names = new Set(cards.map((c) => c.job.photographer?.name ?? ""));
  const [only] = [...names];
  return names.size === 1 && only ? `Waiting for ${only} to check` : "Waiting to be checked";
}

/**
 * My jobs (docs/SIMPLIFICATION-PLAN.md §6): the editor's home. Sections in a fixed order, each hidden when
 * empty: Changes asked · Late · To do · Waiting for <name> to check (collapsed) · Done recently (collapsed).
 * Editors see only their own jobs and only their own numbers.
 */
export default async function MyJobsPage() {
  const { ctx, db } = await pageContext();
  const data = await load(() => getMyJobs(db, ctx));
  const timeZone = ctx.settings.timezone;
  const activeCount = data.changesAsked.length + data.late.length + data.toDo.length;
  const hasWork = activeCount + data.waitingForCheck.length > 0;
  const nothingAtAll = !hasWork && data.doneRecently.length === 0;

  const cards = (list: MyJobCard[], kind: MyJobCardKind) => (
    <CardGrid>
      {list.map((card) => (
        <MyJobCardView key={card.job.id} card={card} kind={kind} timeZone={timeZone} />
      ))}
    </CardGrid>
  );

  return (
    <PageContainer>
      <NextUp name={data.viewer.name} nextUp={data.nextUp} hasWork={hasWork} timeZone={timeZone} />

      {nothingAtAll ? (
        <EmptyState icon={ListChecks} title="No jobs yet" description="When the studio gives you a job it appears here with its raw files and due date." />
      ) : null}

      {data.changesAsked.length > 0 ? (
        <JobSection title="Changes asked" count={data.changesAsked.length} hint="Do these first." tone="danger">
          {cards(data.changesAsked, "changes_asked")}
        </JobSection>
      ) : null}

      {data.late.length > 0 ? (
        <JobSection title="Late" count={data.late.length} tone="attention">
          {cards(data.late, "late")}
        </JobSection>
      ) : null}

      {data.toDo.length > 0 ? (
        <JobSection title="To do" count={data.toDo.length} hint="Soonest due date first.">
          {cards(data.toDo, "to_do")}
        </JobSection>
      ) : null}

      {data.waitingForCheck.length > 0 ? (
        <JobSection title={waitingTitle(data.waitingForCheck)} count={data.waitingForCheck.length} tone="muted" collapsed>
          {cards(data.waitingForCheck, "waiting")}
        </JobSection>
      ) : null}

      {data.doneRecently.length > 0 ? (
        <JobSection title="Done recently" count={data.doneRecently.length} hint="The last 30 days." tone="muted" collapsed>
          {cards(data.doneRecently, "done")}
        </JobSection>
      ) : null}

      <ThisMonthFooter footer={data.thisMonth} />
    </PageContainer>
  );
}
