import type { Metadata } from "next";
import { ComingUpSection, EmptyStudio, FirstRunHome, GetSetUpCard, HomeTopline, NeedsAttentionSection, ReadyToCheckSection, SimplerNoticeCard, YourEditorsSection } from "@/components/home";
import { PageContainer } from "@/components/shell";
import { todayCivil } from "@/lib/dates";
import { allowed, load, pageContext } from "@/server/page";
import { getOwnerHome } from "@/server/queries/home";
import { getOnboarding } from "@/server/queries/onboarding";

export const metadata: Metadata = { title: "Home" };

/**
 * /home — the fixed Home for the owner / co-owners and extra photographers
 * (docs/SIMPLIFICATION-PLAN.md §6). No Customise, no KPI tiles, no scope switch:
 *
 *   topline        "3 to check · 2 late · 1 needs an editor" + New job
 *   Ready to check  oldest first, Approve / Ask for changes inline
 *   Needs attention plain reasons; "Nothing needs you right now."
 *   Your editors    owners only — On their desk · Late · On time this month
 *   Coming up       shoots and due dates for the next 7 days
 *
 * Scope is the viewer's visible jobs (owner: everything; extra photographer: their shoots).
 *
 * Front door: owners of a NEW studio also get the "Get set up" checklist (`getOnboarding().show`);
 * with no jobs at all it replaces the topline with a welcome and takes centre stage.
 */
export default async function HomePage() {
  const { ctx, db } = await pageContext();
  const home = await load(() => getOwnerHome(db, ctx));
  const onboarding = await load(() => getOnboarding(db, ctx));
  const checklist = onboarding?.show ? onboarding : null;
  const timeZone = ctx.settings.timezone;
  const today = todayCivil(timeZone, new Date(home.asOf));
  const canCreate = allowed(ctx, "job.create");
  const canInvite = home.viewer.isAdmin;
  // Owners always; members with the Assign editors switch (the dialog's route re-checks per job).
  const canAssign = home.viewer.isAdmin || ctx.canAssignEditors;

  if (home.emptyStudio && checklist) {
    return (
      <PageContainer>
        <FirstRunHome viewerName={home.viewer.name} state={checklist} canCreate={canCreate} canInvite={canInvite} />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <HomeTopline home={home} timeZone={timeZone} canCreate={canCreate} />
      {/* The one-time "got simpler" card is for studios that saw the old screens; never on top of a new studio's checklist. */}
      {home.simplerNotice && !checklist ? <SimplerNoticeCard /> : null}
      {checklist ? <GetSetUpCard state={checklist} /> : null}
      {home.emptyStudio ? (
        <EmptyStudio canCreate={canCreate} canInvite={canInvite} />
      ) : (
        <>
          <ReadyToCheckSection cards={home.readyToCheck} total={home.topline.toCheck} asOf={home.asOf} timeZone={timeZone} />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <NeedsAttentionSection rows={home.needsAttention} more={home.needsAttentionMore} lateTotal={home.topline.late} today={today} timeZone={timeZone} canAssign={canAssign} />
            <ComingUpSection items={home.comingUp} today={today} />
          </div>
          {home.yourEditors ? <YourEditorsSection rows={home.yourEditors} pending={home.pendingEditors ?? []} canInvite={canInvite} /> : null}
        </>
      )}
    </PageContainer>
  );
}
