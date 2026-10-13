import type { Metadata } from "next";
import { PageContainer } from "@/components/shell/page-container";
import { ShootTypesManager, type ShootTypeRow } from "@/components/settings/shoot-types-manager";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { getSettingsView } from "@/server/queries/settings";
import { loadUsualDaysToEdit } from "@/server/queries/simpleColumns";
import { listJobTypes, listWorkflows } from "@/server/queries/workflows";
import { advancedEnabled, allowed, guard, load, pageContext } from "@/server/page";

export const metadata: Metadata = { title: "Types of shoot" };

/** Settings → Types of shoot (docs/SIMPLIFICATION-PLAN.md §3, §8): name, colour and usual days to edit. */
export default async function ShootTypesPage() {
  const { ctx, db } = await pageContext();
  guard(ctx, "job_type.manage");
  const advanced = advancedEnabled(ctx);
  const jobTypes = await load(() => listJobTypes(db, ctx, { includeArchived: true }));
  const usualDays = await load(() => loadUsualDaysToEdit(db, ctx));
  const shootTypes: ShootTypeRow[] = jobTypes.map((t) => ({ ...t, usualDaysToEdit: usualDays.get(t.id) ?? null }));
  const workflows = advanced
    ? (await load(() => listWorkflows(db, ctx))).filter((w) => w.archivedAt === null).map((w) => ({ id: w.id, name: w.name, isDefault: w.isDefault }))
    : [];
  const settings = (await load(() => getSettingsView(db, ctx))).settings;

  return (
    <PageContainer width="narrow">
      <PageHeader
        eyebrow="Settings"
        title="Types of shoot"
        description="The kinds of shoot you do. Each one has a colour and the number of days editing usually takes, which sets the suggested due date on a new job."
        meta={
          <Badge variant="neutral" className="numeric">
            {shootTypes.filter((t) => t.archivedAt === null).length}
          </Badge>
        }
      />
      <ShootTypesManager
        shootTypes={shootTypes}
        workflows={workflows}
        canManage={allowed(ctx, "job_type.manage")}
        advanced={advanced}
        defaultEstimatedHours={settings.defaultEstimatedHours}
        timeZone={ctx.settings.timezone}
      />
    </PageContainer>
  );
}
