import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, SearchX, UserPlus, Users } from "lucide-react";
import { PageContainer } from "@/components/shell/page-container";
import { UsersToolbar } from "@/components/settings/users-toolbar";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { ROLES, ROLE_LABELS, type Role } from "@/lib/constants";
import { formatDateTime, formatRelative } from "@/lib/dates";
import type { TeamRef, UserProfile, UserRef } from "@/lib/types";
import { getSettingsView } from "@/server/queries/settings";
import { teamsByUser } from "@/server/queries/teams";
import { listUsers } from "@/server/queries/users";
import { allowed, guard, load, pageContext, param } from "@/server/page";

export const metadata: Metadata = { title: "Users" };

function isProfile(u: UserProfile | UserRef): u is UserProfile {
  return "email" in u;
}

const ROLE_BADGE: Record<Role, "solid" | "accent" | "info" | "neutral"> = {
  owner: "solid",
  manager: "accent",
  photographer: "info",
  editor: "neutral",
};

function TeamList({ teams }: { teams: TeamRef[] }) {
  if (teams.length === 0) return <span className="text-ink-subtle">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {teams.map((t) => (
        <Badge key={t.id} variant="outline" size="sm">
          {t.name}
        </Badge>
      ))}
    </span>
  );
}

export default async function UsersSettingsPage({ searchParams }: PageProps<"/settings/users">) {
  const { ctx, db } = await pageContext();
  guard(ctx, "settings.view");
  const sp = await searchParams;
  const q = param(sp, "q")?.trim() || undefined;
  const roleParam = param(sp, "role");
  const role = roleParam && (ROLES as readonly string[]).includes(roleParam) ? (roleParam as Role) : undefined;
  const status = param(sp, "status") ?? "active";
  const active = status === "all" ? undefined : status === "inactive" ? "0" : "1";

  const tz = ctx.settings.timezone;
  const settings = (await load(() => getSettingsView(db, ctx))).settings;
  const users = (await load(() => listUsers(db, ctx, { q, role, active }))).filter(isProfile);
  const teams = await teamsByUser(
    db,
    ctx,
    users.map((u) => u.id),
  );
  const canInvite = allowed(ctx, "user.invite");
  const filtered = Boolean(q || role || status !== "active");
  const capacityOf = (u: UserProfile) => u.capacityHoursPerWeek ?? settings.defaultCapacityHoursPerWeek;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Settings"
        title="Users"
        description="Everyone with access to the studio. Deactivated people keep their history; nothing is ever deleted."
        meta={
          <Badge variant="neutral" className="numeric">
            {users.length}
          </Badge>
        }
      />
      <UsersToolbar viewerRole={ctx.role} canInvite={canInvite} defaultCapacity={settings.defaultCapacityHoursPerWeek} />

      {users.length === 0 ? (
        <Card>
          {filtered ? (
            <EmptyState
              icon={SearchX}
              title="No one matches these filters"
              description="Try another name, role or status — deactivated people are under “Deactivated”."
              action={
                <Button variant="outline" href="/settings/users">
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Users}
              title="No users yet"
              description="Invite your photographers and editors to start assigning work."
              action={
                canInvite ? (
                  <Button href="/settings/users?invite=1" leadingIcon={<UserPlus aria-hidden="true" />}>
                    Invite user
                  </Button>
                ) : undefined
              }
            />
          )}
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <Card flush className="hidden overflow-hidden md:flex">
            <Table density="default">
              <THead>
                <tr>
                  <TH>Name</TH>
                  <TH>Role</TH>
                  <TH>Teams</TH>
                  <TH numeric>Capacity</TH>
                  <TH>Status</TH>
                  <TH>Last sign-in</TH>
                  <TH shrink>
                    <span className="sr-only">Open</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {users.map((u) => (
                  <TR key={u.id} className="group">
                    <TD>
                      <Link href={`/settings/users/${u.id}`} className="flex min-w-0 items-center gap-3 rounded-sm focus-ring">
                        <Avatar name={u.name} colour={u.avatarColour} size="md" className={u.isActive ? undefined : "opacity-50 grayscale"} />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-ink group-hover:text-accent-ink">{u.name}</span>
                          <span className="block truncate text-xs text-ink-muted">{u.email}</span>
                        </span>
                      </Link>
                    </TD>
                    <TD>
                      <Badge variant={ROLE_BADGE[u.role]} size="sm">
                        {ROLE_LABELS[u.role]}
                      </Badge>
                      {u.title ? <span className="mt-0.5 block text-xs text-ink-muted">{u.title}</span> : null}
                    </TD>
                    <TD>
                      <TeamList teams={teams.get(u.id) ?? []} />
                    </TD>
                    <TD numeric>
                      <span className="text-ink">{capacityOf(u)}</span>
                      <span className="text-ink-subtle"> h</span>
                      {u.capacityHoursPerWeek === null ? <span className="block text-2xs text-ink-subtle">default</span> : null}
                    </TD>
                    <TD>
                      {u.anonymisedAt ? (
                        <Badge variant="neutral" size="sm">
                          Anonymised
                        </Badge>
                      ) : u.isActive ? (
                        <Badge variant="success" size="sm" dot>
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="danger" size="sm" dot>
                          Deactivated
                        </Badge>
                      )}
                    </TD>
                    <TD muted>
                      {u.lastLoginAt ? (
                        <time dateTime={u.lastLoginAt} title={formatDateTime(u.lastLoginAt, tz)}>
                          {formatRelative(u.lastLoginAt)}
                        </time>
                      ) : (
                        <span className="text-ink-subtle">Never</span>
                      )}
                    </TD>
                    <TD>
                      <Link
                        href={`/settings/users/${u.id}`}
                        aria-label={`Manage ${u.name}`}
                        className="flex size-7 items-center justify-center rounded-sm text-ink-subtle hover:bg-surface-muted hover:text-ink focus-ring"
                      >
                        <ChevronRight aria-hidden="true" className="size-4" />
                      </Link>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>

          {/* Mobile cards */}
          <ul className="flex flex-col gap-2 md:hidden">
            {users.map((u) => (
              <li key={u.id}>
                <Link
                  href={`/settings/users/${u.id}`}
                  className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3.5 shadow-xs active:bg-surface-muted focus-ring"
                >
                  <Avatar name={u.name} colour={u.avatarColour} size="lg" className={u.isActive ? undefined : "opacity-50 grayscale"} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-ink">{u.name}</span>
                      {!u.isActive ? (
                        <Badge variant="danger" size="sm">
                          Deactivated
                        </Badge>
                      ) : null}
                    </div>
                    <p className="truncate text-sm text-ink-muted">{u.email}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-ink-muted">
                      <span className="font-medium text-ink-secondary">{ROLE_LABELS[u.role]}</span>
                      <span aria-hidden="true">·</span>
                      <span className="numeric">{capacityOf(u)} h/wk</span>
                      <span aria-hidden="true">·</span>
                      <span>{u.lastLoginAt ? `Seen ${formatRelative(u.lastLoginAt)}` : "Never signed in"}</span>
                    </p>
                  </div>
                  <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-subtle" />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </PageContainer>
  );
}
