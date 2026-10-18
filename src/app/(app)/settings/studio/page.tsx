import type { Metadata } from "next";
import { headers } from "next/headers";
import { PageContainer } from "@/components/shell/page-container";
import { EmailStatusCard } from "@/components/settings/email-status-card";
import { AdvancedToolsCard, CloseDeliveredJobsCard, StudioForm } from "@/components/settings/studio-settings";
import { PageHeader } from "@/components/ui/page-header";
import { formatDateTime } from "@/lib/dates";
import { getSettingsView } from "@/server/queries/settings";
import { countDeliveredNotClosed } from "@/server/queries/studio";
import { listWorkflows } from "@/server/queries/workflows";
import { linkOriginStatus, originFromHeaders } from "@/server/origin";
import { getEmailSettings } from "@/server/services/settings";
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

/** Settings → Studio (docs/SIMPLIFICATION-PLAN.md §3, §8, §9): name, timezone, job numbers, Email (front door), Advanced tools, Close delivered jobs. */
export default async function StudioSettingsPage() {
  const { ctx, db } = await pageContext();
  guard(ctx, "settings.view");
  const view = await load(() => getSettingsView(db, ctx));
  const deliveredNotClosed = await load(() => countDeliveredNotClosed(db, ctx));
  // Plan §8 safety: studios with custom workflows (or automations on) had Advanced tools switched on for them.
  const workflows = await load(() => listWorkflows(db, ctx));
  const autoOn = workflows.filter((w) => w.archivedAt === null).length > 1 || view.settings.automationsEnabled;
  // Front door: whether invite / reset links are emailed (RESEND_API_KEY + EMAIL_FROM) or copied from the screen.
  const email = await load(() => getEmailSettings(db, ctx));
  // Which address generated links carry, and whether APP_URL disagrees with the address the owner is on right now.
  const links = linkOriginStatus(originFromHeaders(await headers()));

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
      <EmailStatusCard configured={email.configured} provider={email.provider} from={email.from} links={links} />
      <AdvancedToolsCard view={view} autoOn={autoOn} />
      <CloseDeliveredJobsCard count={deliveredNotClosed} canRun={allowed(ctx, "job.complete") && view.canManage} />
    </PageContainer>
  );
}
