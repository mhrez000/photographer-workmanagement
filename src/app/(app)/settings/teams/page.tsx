import type { Metadata } from "next";
import { PageContainer } from "@/components/shell/page-container";
import { TeamsManager } from "@/components/settings/teams-manager";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import type { ReducedUser, UserProfile, UserRef } from "@/lib/types";
import { getTeamDetail, listTeams } from "@/server/queries/teams";
import { listUsers } from "@/server/queries/users";
import { advancedPageContext, allowed, guard, load } from "@/server/page";

export const metadata: Metadata = { title: "Teams" };

function toRef(u: UserProfile | ReducedUser): UserRef {
  return { id: u.id, name: u.name, role: u.role, avatarColour: u.avatarColour, isActive: u.isActive, isAdmin: u.isAdmin, title: u.title };
}

export default async function TeamsSettingsPage() {
  const { ctx, db } = await advancedPageContext("teams", "/settings/people"); // Advanced gate before any query (see src/server/page.ts)
  guard(ctx, "settings.view");
  const canManage = allowed(ctx, "team.manage");
  const list = await load(() => listTeams(db, ctx, { includeArchived: canManage ? "1" : undefined }));
  const teams = await Promise.all(list.map((t) => load(() => getTeamDetail(db, ctx, t.id))));
  // Teams group staff only: client portal users can never be team members (docs/ROLES.md §3.4).
  const people = (await load(() => listUsers(db, ctx, { active: "1" }))).filter((u) => u.role !== "client").map(toRef);
  const activeCount = teams.filter((t) => t.archivedAt === null).length;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Settings"
        title="Teams"
        description="Who works together. Teams decide team-job visibility and team workloads; membership changes are kept as history."
        meta={
          <Badge variant="neutral" className="numeric">
            {activeCount}
          </Badge>
        }
      />
      <TeamsManager teams={teams} people={people} canManage={canManage} timeZone={ctx.settings.timezone} />
    </PageContainer>
  );
}
