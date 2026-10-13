import type { Metadata } from "next";
import { PageContainer } from "@/components/shell/page-container";
import { AdvancedToolsCard, CloseDeliveredJobsCard, StudioForm } from "@/components/settings/studio-settings";
import { PageHeader } from "@/components/ui/page-header";
import { formatDateTime } from "@/lib/dates";
import { getSettingsView } from "@/server/queries/settings";
import { countDeliveredNotClosed } from "@/server/queries/studio";
import { listWorkflows } from "@/server/queries/workflows";
import { allowed, guard, load, pageContext } from "@/server/page";

export const metadata: Metadata = { title: "Studio settings" };

/** IANA zones from the server's ICU (passed down so server and client render the same list). */
function timeZones(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  return zones.includes(current) ? zones : [current, ...zones];
}

/** Settings → Studio (docs/SIMPLIFICATION-PLAN.md §3, §8, §9): name, timezone, job numbers, Advanced tools, Close delivered jobs. */
export default async function StudioSettingsPage() {
  const { ctx, db } = await pageContext();
  guard(ctx, "settings.view");
  const view = await load(() => getSettingsView(db, ctx));
  const deliveredNotClosed = await load(() => countDeliveredNotClosed(db, ctx));
  // Plan §8 safety: studios with custom workflows (or automations on) had Advanced tools switched on for them.
  const workflows = await load(() => listWorkflows(db, ctx));
  const autoOn = workflows.filter((w) => w.archivedAt === null).length > 1 || view.settings.automationsEnabled;

  return (
    <PageContainer width="narrow">
      <PageHeader
        eyebrow="Settings"
        title="Studio"
        description="How your studio is set up. Every change here is recorded under History."
      >
        <p className="text-xs text-ink-subtle">
          Last changed <span className="numeric">{formatDateTime(view.settings.updatedAt, ctx.settings.timezone)}</span>
        </p>
      </PageHeader>
      <StudioForm view={view} timeZones={timeZones(view.settings.timezone)} />
      <AdvancedToolsCard view={view} autoOn={autoOn} />
      <CloseDeliveredJobsCard count={deliveredNotClosed} canRun={allowed(ctx, "job.complete") && view.canManage} />
    </PageContainer>
  );
}
