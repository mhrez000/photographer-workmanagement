import type { Metadata } from "next";
import Link from "next/link";
import { History, Store } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { PageContainer } from "@/components/shell/page-container";
import { InviteStatusCard } from "@/components/settings/invite-status-card";
import { PersonAccessCard, type PersonAccess } from "@/components/settings/person-access-card";
import { TransferPrimaryOwnerCard, UserProfileCard, type UserAdminAccess } from "@/components/settings/user-admin";
import { UserLifecycleCard, type LifecycleAccess, type OpenJobBrief } from "@/components/settings/user-lifecycle";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CATEGORY_GROUPS, PHOTOGRAPHER_PRESET_META, photographerPresetOf } from "@/lib/constants";
import { formatDate, formatDateTime, formatRelative } from "@/lib/dates";
import { STAGE_META, stageOf } from "@/lib/stages";
import type { ActivityFeedItem, JobRow, ReducedUser, UserProfile } from "@/lib/types";
import { DEMO_BLOCKED_MESSAGES, isDemoPersonaEmail } from "@/server/auth/demo";
import type { UserPermissionRef } from "@/server/auth/permissions";
import { listActivity } from "@/server/queries/activity";
import { listClients } from "@/server/queries/clients";
import { listJobs } from "@/server/queries/jobs";
import { getSettingsView } from "@/server/queries/settings";
import { getUserDetail, listUsers } from "@/server/queries/users";
import { pendingInviteFor } from "@/server/services/invites";
import { advancedEnabled, allowed, guard, load, pageContext } from "@/server/page";

export const metadata: Metadata = { title: "Person" };

/** Open jobs as the lifecycle dialog lists them, with the stage (not the raw status) as the label. */
function brief(rows: JobRow[]): OpenJobBrief[] {
  return rows.map((r) => {
    const stage = stageOf(r.status.category);
    return { id: r.id, jobNumber: r.jobNumber, name: r.name, statusName: STAGE_META[stage].label, statusColour: r.status.colour };
  });
}

function roleHeadline(u: UserProfile, isPrimaryOwner: boolean): string {
  if (u.role === "client") return "Client";
  if (u.role === "editor") return u.canCreateJobs ? "Editor · can add their own jobs" : "Editor";
  if (isPrimaryOwner) return "Owner";
  const preset = photographerPresetOf(u);
  if (preset === "co_owner") return "Co-owner";
  if (preset === "own_shoots") return `Photographer · ${PHOTOGRAPHER_PRESET_META.own_shoots.label.toLowerCase()}`;
  return "Photographer · custom";
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

/** Settings → People → person (docs/SIMPLIFICATION-PLAN.md §2, §8): profile, one access choice, temporary password, deactivate with "move their jobs to…". */
export default async function PersonPage({ params }: PageProps<"/settings/people/[id]">) {
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
  const advanced = advancedEnabled(ctx);

  // Every control is decided by can() on the full target ref (primary-owner protection included).
  const target: UserPermissionRef = {
    id: profile.id,
    role: profile.role,
    isActive: profile.isActive,
    organisationId: profile.organisationId,
    isAdmin: profile.isAdmin,
    isPrimaryOwner,
  };
  // Accounts (docs/ACCOUNTS.md §7): in the demo studio the four persona accounts are fixed, nobody's email or password
  // changes and invites are off — the services refuse it (403), so the controls are not offered at all.
  const demo = ctx.isDemo === true;
  const demoPersona = demo && isDemoPersonaEmail(profile.email);
  const lockedReason = demoPersona
    ? DEMO_BLOCKED_MESSAGES.demo_accounts
    : isPrimaryOwner && !isSelf
      ? `Only ${profile.name} can change their own account: they are the owner.`
      : isSelf
        ? "This is you. Some changes need another owner."
        : null;
  const profileAccess: UserAdminAccess = {
    edit: allowed(ctx, "user.edit", target),
    changeEmail: !demo && allowed(ctx, "user.change_email", target),
    changeRole: false,
    grantAdmin: false,
    revokeAdmin: false,
    setPermissions: false,
    setCapacity: false,
    lockedReason,
  };
  const access: PersonAccess = {
    grantAdmin: !demoPersona && allowed(ctx, "user.set_admin", { ...target, nextIsAdmin: true }),
    revokeAdmin: !demoPersona && allowed(ctx, "user.set_admin", { ...target, nextIsAdmin: false }),
    setPermissions: !demoPersona && allowed(ctx, "user.set_permissions", target),
    setCapacity: allowed(ctx, "user.set_capacity", target),
    lockedReason,
  };
  // Front door: not joined yet (accepted_at null) → the Invite card (Send a new link / Revoke) replaces "Active".
  const invitePending = profile.acceptedAt === null && profile.isActive && !profile.anonymisedAt;
  const liveInvite = invitePending ? await load(() => pendingInviteFor(db, profile.id, ctx.now())) : null;
  const canInvite = !demo && invitePending && allowed(ctx, "user.invite", { ...target, nextRole: profile.role });
  const lifecycle: LifecycleAccess = {
    resetPassword: !demo && !isSelf && allowed(ctx, "user.reset_password", target),
    deactivate: !demoPersona && allowed(ctx, "user.deactivate", target),
    reactivate: allowed(ctx, "user.reactivate", target),
    anonymise: !demoPersona && allowed(ctx, "user.anonymise", target),
    lockedReason,
  };

  const clientRow = profile.clientId ? (await load(() => listClients(db, ctx, { includeArchived: true }))).find((c) => c.client.id === profile.clientId) : undefined;
  const client = clientRow
    ? { id: clientRow.client.id, name: clientRow.client.name, portalEnabled: clientRow.client.portalEnabled, archived: clientRow.client.archivedAt !== null }
    : null;

  // Transfer ownership: only on the primary owner's own page.
  const isProfileRow = (u: UserProfile | ReducedUser): u is UserProfile => "email" in u;
  const transferCandidates =
    !demo && isSelf && isPrimaryOwner && allowed(ctx, "org.transfer_primary_owner")
      ? (await load(() => listUsers(db, ctx, { role: "photographer", active: "1" })))
          .filter(isProfileRow)
          .filter((u) => u.isAdmin && u.id !== profile.id)
          .map((u) => ({ id: u.id, name: u.name }))
      : null;

  const active = [...CATEGORY_GROUPS.ACTIVE];
  const editorJobs = profile.role === "editor" ? (await listJobs(db, ctx, { editorId: [profile.id], statusCategory: active, limit: 200 })).rows : [];
  const photographerJobs = profile.role === "photographer" ? (await listJobs(db, ctx, { photographerId: [profile.id], statusCategory: active, limit: 200 })).rows : [];
  const activity = allowed(ctx, "activity.view_global") ? (await listActivity(db, ctx, { userId: profile.id, limit: 8 })).items : [];

  return (
    <PageContainer width="narrow">
      <PageHeader
        backHref="/settings/people"
        backLabel="People"
        title={
          <span className="flex items-center gap-3">
            <Avatar name={profile.name} colour={profile.avatarColour} size="lg" className={profile.isActive ? undefined : "opacity-50 grayscale"} />
            <span className="min-w-0 truncate">{profile.name}</span>
          </span>
        }
        meta={
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge variant={profile.role === "photographer" && profile.isAdmin ? "solid" : profile.role === "photographer" ? "info" : profile.role === "editor" ? "neutral" : "outline"}>
              {roleHeadline(profile, isPrimaryOwner)}
            </Badge>
            {client ? <Badge variant="outline">{client.name}</Badge> : null}
            {profile.anonymisedAt ? (
              <Badge variant="neutral">Anonymised</Badge>
            ) : invitePending ? (
              <Badge variant="warning" dot data-invite-pending={liveInvite ? "live" : "stale"}>
                Invite pending
              </Badge>
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
            <span>· Joined {formatDate(profile.createdAt, tz)}</span>
            <span>· {profile.lastLoginAt ? `Last seen ${formatRelative(profile.lastLoginAt)}` : invitePending ? "Not joined yet" : "Never signed in"}</span>
            {!profile.isActive && profile.deactivatedAt ? <span>· Deactivated {formatDate(profile.deactivatedAt, tz)}</span> : null}
          </span>
        }
        actions={
          profile.role === "editor" ? (
            <Button variant="outline" size="sm" href={`/editors/${profile.id}`}>
              Their editor page
            </Button>
          ) : undefined
        }
      />

      {invitePending ? (
        <InviteStatusCard
          userId={profile.id}
          name={profile.name}
          email={profile.email}
          pending={liveInvite}
          canInvite={canInvite}
          blockedReason={demo ? `${DEMO_BLOCKED_MESSAGES.invite}.` : null}
          timeZone={tz}
        />
      ) : null}

      {profile.role === "client" ? (
        <SectionCard title="Client portal" description="Client users only see the work shared with their client." actions={<Store aria-hidden="true" className="size-4 text-ink-subtle" />}>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-ink-muted">Client</dt>
              <dd className="mt-0.5 font-medium text-ink">
                {client ? (
                  <Link href={`/clients/${client.id}`} className="text-accent-ink hover:underline">
                    {client.name}
                  </Link>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted">Portal</dt>
              <dd className="mt-0.5">
                {client?.archived ? (
                  <Badge variant="neutral" size="sm">
                    Client archived · cannot sign in
                  </Badge>
                ) : client?.portalEnabled ? (
                  <Badge variant="success" size="sm" dot>
                    On
                  </Badge>
                ) : (
                  <Badge variant="warning" size="sm" dot>
                    Off · cannot sign in
                  </Badge>
                )}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-sm text-ink-muted">A client user always stays with this client. To give someone access to another client, invite a new account.</p>
        </SectionCard>
      ) : null}

      <UserProfileCard profile={profile} access={profileAccess} isPrimaryOwner={isPrimaryOwner} defaultCapacity={settings.defaultCapacityHoursPerWeek} timeZone={tz} client={client} showTitle={advanced} />
      <PersonAccessCard profile={profile} access={access} isPrimaryOwner={isPrimaryOwner} advanced={advanced} timeZone={tz} />
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
        title="Recent changes by them"
        actions={
          activity.length > 0 ? (
            <Button variant="link" size="sm" href={`/settings/history?userId=${profile.id}`}>
              Full history →
            </Button>
          ) : undefined
        }
      >
        {activity.length === 0 ? (
          <EmptyState icon={History} size="sm" title="Nothing yet" description="Changes they make to jobs and settings will show here." />
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
