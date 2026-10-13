import type { Metadata } from "next";
import { ComingUpSection, EmptyStudio, HomeTopline, NeedsAttentionSection, ReadyToCheckSection, SimplerNoticeCard, YourEditorsSection } from "@/components/home";
import { PageContainer } from "@/components/shell";
import { todayCivil } from "@/lib/dates";
import { allowed, load, pageContext } from "@/server/page";
import { getOwnerHome } from "@/server/queries/home";

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
 */
export default async function HomePage() {
  const { ctx, db } = await pageContext();
  const home = await load(() => getOwnerHome(db, ctx));
  const timeZone = ctx.settings.timezone;
  const today = todayCivil(timeZone, new Date(home.asOf));
  const canCreate = allowed(ctx, "job.create");
  const canInvite = home.viewer.isAdmin;
  // Owners always; members with the Assign editors switch (the dialog's route re-checks per job).
  const canAssign = home.viewer.isAdmin || ctx.canAssignEditors;

  return (
    <PageContainer>
      <HomeTopline home={home} timeZone={timeZone} canCreate={canCreate} />
      {home.simplerNotice ? <SimplerNoticeCard /> : null}
      {home.emptyStudio ? (
        <EmptyStudio canCreate={canCreate} canInvite={canInvite} />
      ) : (
        <>
          <ReadyToCheckSection cards={home.readyToCheck} total={home.topline.toCheck} asOf={home.asOf} timeZone={timeZone} />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <NeedsAttentionSection rows={home.needsAttention} more={home.needsAttentionMore} lateTotal={home.topline.late} today={today} timeZone={timeZone} canAssign={canAssign} />
            <ComingUpSection items={home.comingUp} today={today} />
          </div>
          {home.yourEditors ? <YourEditorsSection rows={home.yourEditors} canInvite={canInvite} /> : null}
        </>
      )}
    </PageContainer>
  );
}
