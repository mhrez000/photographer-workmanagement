import type { Metadata } from "next";
import { PageContainer } from "@/components/shell/page-container";
import { OrganisationSettingsForm } from "@/components/settings/organisation-form";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { formatDateTime } from "@/lib/dates";
import { getSettingsView } from "@/server/queries/settings";
import { guard, load, pageContext } from "@/server/page";

export const metadata: Metadata = { title: "Organisation settings" };

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

export default async function OrganisationSettingsPage() {
  const { ctx, db } = await pageContext();
  guard(ctx, "settings.view");
  const view = await load(() => getSettingsView(db, ctx));
  return (
    <PageContainer width="narrow">
      <PageHeader
        eyebrow="Settings"
        title="Organisation"
        description="Studio-wide defaults: timezone, job numbers, thresholds, visibility and the automations switch."
        meta={view.canManage ? null : <Badge variant="outline">Read-only</Badge>}
      >
        <p className="text-xs text-ink-subtle">
          Last changed <span className="numeric">{formatDateTime(view.settings.updatedAt, ctx.settings.timezone)}</span> · every change is recorded in the activity log.
        </p>
      </PageHeader>
      <OrganisationSettingsForm view={view} timeZones={timeZones(view.settings.timezone)} />
    </PageContainer>
  );
}
