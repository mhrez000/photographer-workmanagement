import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, History } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { StatTile } from "@/components/common/stat-tile";
import { WorkloadBand } from "@/components/jobs/workload-band";
import { PageContainer } from "@/components/shell/page-container";
import { UserAccessCard, UserProfileCard } from "@/components/settings/user-admin";
import { UserLifecycleCard, type OpenJobBrief } from "@/components/settings/user-lifecycle";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CATEGORY_GROUPS, ROLE_LABELS } from "@/lib/constants";
import { formatDate, formatDateTime, formatRelative } from "@/lib/dates";
import type { ActivityFeedItem, JobRow } from "@/lib/types";
import { formatPercent } from "@/lib/utils";
import { listActivity } from "@/server/queries/activity";
import { listJobs } from "@/server/queries/jobs";
import { getSettingsView } from "@/server/queries/settings";
import { getUserDetail } from "@/server/queries/users";
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
  const detail = load(() => getUserDetail(db, ctx, id));
  const profile = detail.profile;
  if (!profile) return null; // management always gets the profile; defensive.
  const settings = load(() => getSettingsView(db, ctx)).settings;
  const isSelf = profile.id === ctx.userId;

  const active = [...CATEGORY_GROUPS.ACTIVE];
  const editorJobs = profile.role === "editor" ? listJobs(db, ctx, { editorId: [profile.id], statusCategory: active, limit: 200 }).rows : [];
  const photographerJobs =
    profile.role !== "editor" ? listJobs(db, ctx, { photographerId: [profile.id], statusCategory: active, limit: 200 }).rows : [];
  const activity = allowed(ctx, "activity.view_global") ? listActivity(db, ctx, { userId: profile.id, limit: 12 }).items : [];
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
            <Badge variant="outline">{ROLE_LABELS[profile.role]}</Badge>
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

      <UserProfileCard profile={profile} viewerRole={ctx.role} canManage={detail.canManage} defaultCapacity={settings.defaultCapacityHoursPerWeek} timeZone={tz} />
      <UserAccessCard profile={profile} viewerRole={ctx.role} canManage={detail.canManage} defaultCapacity={settings.defaultCapacityHoursPerWeek} timeZone={tz} />
      <UserLifecycleCard
        profile={profile}
        viewerRole={ctx.role}
        canManage={detail.canManage}
        isSelf={isSelf}
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
