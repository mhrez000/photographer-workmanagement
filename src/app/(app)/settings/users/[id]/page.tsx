import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, History } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { StatTile } from "@/components/common/stat-tile";
import { WorkloadBand } from "@/components/jobs/workload-band";
import { PageContainer } from "@/components/shell/page-container";
import { PERSONA_BADGE } from "@/components/settings/permission-copy";
import { TransferPrimaryOwnerCard, UserAccessCard, UserProfileCard, type UserAdminAccess } from "@/components/settings/user-admin";
import { UserLifecycleCard, type LifecycleAccess, type OpenJobBrief } from "@/components/settings/user-lifecycle";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CATEGORY_GROUPS, displayRoleLabel, personaOfUser } from "@/lib/constants";
import { formatDate, formatDateTime, formatRelative } from "@/lib/dates";
import type { ActivityFeedItem, JobRow, ReducedUser, UserProfile } from "@/lib/types";
import { formatPercent } from "@/lib/utils";
import { listActivity } from "@/server/queries/activity";
import { listJobs } from "@/server/queries/jobs";
import { getSettingsView } from "@/server/queries/settings";
import type { UserPermissionRef } from "@/server/auth/permissions";
import { listClients } from "@/server/queries/clients";
import { getUserDetail, listUsers } from "@/server/queries/users";
import { allowed, guard, load, pageContext } from "@/server/page";

export const metadata: Metadata = { title: "Manage user" };

function brief(rows: JobRow[]): OpenJobBrief[] {
  return rows.map((r) => ({ id: r.id, jobNumber: r.jobNumber, name: r.name, statusName: r.status.name, statusColour: r.status.colour }));
}

function ActivityLine({ item, timeZone }: { item: ActivityFeedItem; timeZone: string }) {
  return (
    <li className="flex gap-3 py-2.5">
      <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-border-strong" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink-secondary">
          <span className="text-ink">{item.summary}</span>
          {item.job ? (
            <>
              {" · "}
              <Link href={`/jobs/${item.job.id}`} className="font-mono text-xs text-accent-ink hover:underline">
                {item.job.jobNumber}
              </Link>{" "}
              <span className="text-ink-muted">{item.job.name}</span>
            </>
          ) : null}
        </p>
        <time dateTime={item.createdAt} title={formatDateTime(item.createdAt, timeZone)} className="text-xs text-ink-subtle">
          {formatRelative(item.createdAt)}
        </time>
      </div>
    </li>
  );
}

export default async function ManageUserPage({ params }: PageProps<"/settings/users/[id]">) {
  const { ctx, db } = await pageContext();
  guard(ctx, "settings.view");
  const { id } = await params;
  const tz = ctx.settings.timezone;
  const detail = await load(() => getUserDetail(db, ctx, id));
  const profile = detail.profile;
  if (!profile) return null; // admins always get the profile; defensive.
  const settings = (await load(() => getSettingsView(db, ctx))).settings;
  const isSelf = profile.id === ctx.userId;
  const primaryOwnerId = settings.primaryOwnerUserId ?? null;
  const isPrimaryOwner = profile.id === primaryOwnerId;

  // Every control is decided by can() on the full target ref (primary-owner protection included, docs/ROLES.md §3.4).
  const target: UserPermissionRef = {
    id: profile.id,
    role: profile.role,
    isActive: profile.isActive,
    organisationId: profile.organisationId,
    isAdmin: profile.isAdmin,
    isPrimaryOwner,
  };
  const lockedReason =
    isPrimaryOwner && !isSelf ? `Only ${profile.name} can change their own account — they are the primary owner.` : isSelf ? "This is you. Some changes need another admin." : null;
  const access: UserAdminAccess = {
    edit: allowed(ctx, "user.edit", target),
    changeEmail: allowed(ctx, "user.change_email", target),
    changeRole: allowed(ctx, "user.change_role", target),
    grantAdmin: allowed(ctx, "user.set_admin", { ...target, nextIsAdmin: true }),
    revokeAdmin: allowed(ctx, "user.set_admin", { ...target, nextIsAdmin: false }),
    setPermissions: allowed(ctx, "user.set_permissions", target),
    setCapacity: allowed(ctx, "user.set_capacity", target),
    lockedReason,
  };
  const lifecycle: LifecycleAccess = {
    resetPassword: !isSelf && allowed(ctx, "user.reset_password", target),
    deactivate: allowed(ctx, "user.deactivate", target),
    reactivate: allowed(ctx, "user.reactivate", target),
    anonymise: allowed(ctx, "user.anonymise", target),
    lockedReason,
  };

  const clientRow = profile.clientId ? (await load(() => listClients(db, ctx, { includeArchived: true }))).find((c) => c.client.id === profile.clientId) : undefined;
  const client = clientRow
    ? { id: clientRow.client.id, name: clientRow.client.name, portalEnabled: clientRow.client.portalEnabled, archived: clientRow.client.archivedAt !== null }
    : null;

  // Transfer primary ownership: only on the primary owner's own page.
  const isProfileRow = (u: UserProfile | ReducedUser): u is UserProfile => "email" in u;
  const transferCandidates =
    isSelf && isPrimaryOwner && allowed(ctx, "org.transfer_primary_owner")
      ? (await load(() => listUsers(db, ctx, { role: "photographer", active: "1" })))
          .filter(isProfileRow)
          .filter((u) => u.isAdmin && u.id !== profile.id)
          .map((u) => ({ id: u.id, name: u.name }))
      : null;

  const active = [...CATEGORY_GROUPS.ACTIVE];
  const editorJobs = profile.role === "editor" ? (await listJobs(db, ctx, { editorId: [profile.id], statusCategory: active, limit: 200 })).rows : [];
  const photographerJobs =
    profile.role === "photographer" ? (await listJobs(db, ctx, { photographerId: [profile.id], statusCategory: active, limit: 200 })).rows : [];
  const activity = allowed(ctx, "activity.view_global") ? (await listActivity(db, ctx, { userId: profile.id, limit: 12 })).items : [];
  const workload = detail.workload;

  return (
    <PageContainer width="narrow">
      <PageHeader
        backHref="/settings/users"
        backLabel="All users"
        title={
          <span className="flex items-center gap-3">
            <Avatar name={profile.name} colour={profile.avatarColour} size="lg" className={profile.isActive ? undefined : "opacity-50 grayscale"} />
            <span className="min-w-0 truncate">{profile.name}</span>
          </span>
        }
        meta={
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge variant={PERSONA_BADGE[personaOfUser(profile)]}>{displayRoleLabel({ role: profile.role, isAdmin: profile.isAdmin })}</Badge>
            {isPrimaryOwner ? <Badge variant="accent">Owner</Badge> : null}
            {client ? <Badge variant="outline">{client.name}</Badge> : null}
            {profile.anonymisedAt ? (
              <Badge variant="neutral">Anonymised</Badge>
            ) : profile.isActive ? (
              <Badge variant="success" dot>
                Active
              </Badge>
            ) : (
              <Badge variant="danger" dot>
                Deactivated
              </Badge>
            )}
            {isSelf ? <Badge variant="accent">You</Badge> : null}
          </span>
        }
        description={
          <span className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
            <span>{profile.email}</span>
            {profile.title ? <span>· {profile.title}</span> : null}
            {detail.teams.length > 0 ? <span>· {detail.teams.map((t) => t.name).join(", ")}</span> : null}
            <span>· Joined {formatDate(profile.createdAt, tz)}</span>
            <span>· {profile.lastLoginAt ? `Last seen ${formatRelative(profile.lastLoginAt)}` : "Never signed in"}</span>
            {!profile.isActive && profile.deactivatedAt ? <span>· Deactivated {formatDate(profile.deactivatedAt, tz)}</span> : null}
          </span>
        }
        actions={
          profile.role === "editor" || profile.role === "photographer" ? (
            <Button variant="outline" size="sm" href={`/team/users/${profile.id}`} trailingIcon={<ArrowUpRight aria-hidden="true" />}>
              Team profile
            </Button>
          ) : undefined
        }
      />

      {workload && profile.role === "editor" ? (
        <SectionCard
          title="Current workload"
          description={`Capacity ${detail.capacityHoursPerWeek ?? settings.defaultCapacityHoursPerWeek} h/wk · ${detail.openJobCount ?? 0} open jobs`}
          actions={<WorkloadBand band={workload.band} ratio={workload.ratio} reason={workload.bandReason} showRatio />}
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Active" value={workload.active} />
            <StatTile label="Due today" value={workload.dueToday} tone={workload.dueToday > 0 ? "attention" : undefined} />
            <StatTile label="Overdue" value={workload.overdue} tone={workload.overdue > 0 ? "danger" : undefined} />
            <StatTile label="Revision rate" value={workload.revisionRate === null ? "—" : formatPercent(workload.revisionRate)} sub="last 30 days" />
          </div>
        </SectionCard>
      ) : null}

      <UserProfileCard
        profile={profile}
        access={access}
        isPrimaryOwner={isPrimaryOwner}
        defaultCapacity={settings.defaultCapacityHoursPerWeek}
        timeZone={tz}
        client={client}
      />
      <UserAccessCard
        profile={profile}
        access={access}
        isPrimaryOwner={isPrimaryOwner}
        defaultCapacity={settings.defaultCapacityHoursPerWeek}
        timeZone={tz}
        client={client}
      />
      {transferCandidates ? <TransferPrimaryOwnerCard candidates={transferCandidates} settingsVersion={settings.version} /> : null}
      <UserLifecycleCard
        profile={profile}
        access={lifecycle}
        isSelf={isSelf}
        targetIsAdmin={profile.role === "photographer" && profile.isAdmin}
        editorJobs={brief(editorJobs)}
        photographerJobs={brief(photographerJobs)}
        timeZone={tz}
      />

      <SectionCard
        title="Recent activity"
        description="What this person changed most recently."
        actions={
          activity.length > 0 ? (
            <Button variant="link" size="sm" href={`/activity?userId=${profile.id}`}>
              Full history →
            </Button>
          ) : undefined
        }
      >
        {activity.length === 0 ? (
          <EmptyState icon={History} size="sm" title="No activity yet" description="Changes they make to jobs and settings will appear here." />
        ) : (
          <ol className="-my-1 divide-y divide-border">
            {activity.map((item) => (
              <ActivityLine key={item.id} item={item} timeZone={tz} />
            ))}
          </ol>
        )}
      </SectionCard>
    </PageContainer>
  );
}
