import type { Metadata } from "next";
import { AlarmClock, Gauge, TriangleAlert, Users } from "lucide-react";
import { StatTile } from "@/components/common/stat-tile";
import { PageContainer } from "@/components/shell";
import { WorkloadBoard } from "@/components/team/workload-board";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import type { UserProfile } from "@/lib/types";
import { pluralise } from "@/lib/utils";
import { loadOrgSettings } from "@/server/queries/metrics";
import { listUsers } from "@/server/queries/users";
import { getWorkloads } from "@/server/queries/workloads";
import { allowed, guard, load, pageContext } from "@/server/page";

export const metadata: Metadata = { title: "Workloads" };

export default async function WorkloadsPage() {
  const { ctx, db } = await pageContext();
  guard(ctx, "workloads.view_team");
  const rows = load(() => getWorkloads(db, ctx));
  const settings = loadOrgSettings(db, ctx);

  let capacityEdit: Record<string, { version: number; usesDefault: boolean }> | null = null;
  if (allowed(ctx, "user.set_capacity")) {
    capacityEdit = {};
    const ids = new Set(rows.map((r) => r.editor.id));
    for (const u of load(() => listUsers(db, ctx, { role: "editor" }))) {
      const p = u as UserProfile;
      if (!ids.has(p.id) || typeof p.version !== "number") continue;
      if (!allowed(ctx, "user.set_capacity", { id: p.id, role: p.role, isActive: p.isActive, organisationId: p.organisationId })) continue;
      capacityEdit[p.id] = { version: p.version, usesDefault: p.capacityHoursPerWeek === null };
    }
  }

  const activeRows = rows.filter((r) => r.editor.isActive);
  const overloaded = activeRows.filter((r) => r.band === "overloaded");
  const near = activeRows.filter((r) => r.band === "near_capacity");
  const capacity = activeRows.reduce((s, r) => s + r.editor.capacityHoursPerWeek, 0);
  const load_ = activeRows.reduce((s, r) => s + r.score, 0);
  const utilisation = capacity > 0 ? load_ / capacity : null;
  const stranded = rows.filter((r) => !r.editor.isActive && r.active > 0);
  const strandedJobs = stranded.reduce((s, r) => s + r.active, 0);
  const overdue = rows.reduce((s, r) => s + r.overdue, 0);
  const headroom = activeRows.filter((r) => r.band === "healthy").sort((a, b) => a.ratio - b.ratio)[0];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Team"
        title="Workloads"
        description="Who is overloaded, who has room, and what is stuck with someone who's left. Click a person for their jobs and history."
        actions={
          <Button variant="outline" href="/team/editors" leadingIcon={<Users aria-hidden="true" />}>
            Editors
          </Button>
        }
      />

      <section aria-label="Team capacity" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Team utilisation"
          value={utilisation === null ? "—" : `${Math.round(utilisation * 100)}%`}
          tone={utilisation === null ? "default" : utilisation >= settings.workloadOverloadedRatio ? "danger" : utilisation >= settings.workloadNearCapacityRatio ? "attention" : "accent"}
          sub={`${load_.toFixed(0)}h load of ${capacity.toFixed(0)}h / week`}
          icon={Gauge}
        />
        <StatTile
          label="Overloaded"
          value={overloaded.length}
          tone={overloaded.length > 0 ? "danger" : "success"}
          sub={overloaded.length > 0 ? overloaded.map((r) => r.editor.name.split(" ")[0]).slice(0, 3).join(", ") : near.length > 0 ? `${near.length} near capacity` : "Nobody over capacity"}
          icon={TriangleAlert}
        />
        <StatTile
          label="Most headroom"
          value={headroom ? headroom.editor.name.split(" ")[0] : "—"}
          sub={headroom ? `${Math.round(headroom.ratio * 100)}% used · ${pluralise(headroom.active, "active job")}` : "Everyone is near or over capacity"}
          tone={headroom ? "accent" : "attention"}
          href={headroom ? `/team/users/${headroom.editor.id}` : undefined}
        />
        <StatTile
          label={stranded.length > 0 ? "Jobs to reassign" : "Overdue"}
          value={stranded.length > 0 ? strandedJobs : overdue}
          tone={stranded.length > 0 || overdue > 0 ? "danger" : "success"}
          sub={
            stranded.length > 0
              ? `Held by ${pluralise(stranded.length, "deactivated editor")}`
              : overdue > 0
                ? "Across all editors"
                : "Nothing overdue"
          }
          icon={AlarmClock}
          href={stranded.length > 0 ? undefined : "/workspace/all?quick=overdue"}
        />
      </section>

      <WorkloadBoard
        rows={rows}
        timeZone={ctx.settings.timezone}
        capacityEdit={capacityEdit}
        defaultCapacityHours={settings.defaultCapacityHoursPerWeek}
        canReassign={allowed(ctx, "job.bulk_reassign")}
      />
    </PageContainer>
  );
}
