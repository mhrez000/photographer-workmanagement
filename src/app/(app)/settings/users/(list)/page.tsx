import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, SearchX, Store, UserPlus, Users } from "lucide-react";
import { PageContainer } from "@/components/shell/page-container";
import { PERSONA_BADGE } from "@/components/settings/permission-copy";
import { RolesMigrationNotice } from "@/components/settings/roles-notice";
import { TEAM_PERSONA_FILTERS, UsersToolbar, type TeamPersonaFilter } from "@/components/settings/users-toolbar";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { STAFF_ROLES, personaLabel, personaOfUser } from "@/lib/constants";
import { formatDateTime, formatRelative } from "@/lib/dates";
import type { ReducedUser, TeamRef, UserProfile } from "@/lib/types";
import { cn } from "@/lib/utils";
import { listClients } from "@/server/queries/clients";
import { getRolesNotice } from "@/server/queries/roles-notice";
import { getSettingsView } from "@/server/queries/settings";
import { teamsByUser } from "@/server/queries/teams";
import { listUsers } from "@/server/queries/users";
import { allowed, guard, load, pageContext, param } from "@/server/page";

export const metadata: Metadata = { title: "Users" };

function isProfile(u: UserProfile | ReducedUser): u is UserProfile {
  return "email" in u;
}

/** Persona badge + "Owner" marker for the primary owner (docs/ROLES.md §6.1, §11). */
function RoleCell({ user, isPrimaryOwner, clientName }: { user: UserProfile; isPrimaryOwner: boolean; clientName?: string | null }) {
  return (
    <span className="flex flex-col items-start gap-0.5">
      <span className="flex flex-wrap items-center gap-1">
        <Badge variant={PERSONA_BADGE[personaOfUser(user)]} size="sm">
          {personaLabel(user)}
        </Badge>
        {isPrimaryOwner ? (
          <Badge variant="accent" size="sm">
            Owner
          </Badge>
        ) : null}
      </span>
      {user.role === "client" && clientName ? <span className="text-xs text-ink-muted">{clientName}</span> : null}
      {user.title ? <span className="text-xs text-ink-muted">{user.title}</span> : null}
    </span>
  );
}

function TabLink({ href, active, children, count }: { href: string; active: boolean; children: React.ReactNode; count?: number }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "-mb-px inline-flex items-center gap-2 rounded-t-xs border-b-2 px-1 pb-2.5 text-sm font-medium focus-ring",
        active ? "border-accent text-ink" : "border-transparent text-ink-muted hover:text-ink",
      )}
    >
      {children}
      {count !== undefined ? <span className="numeric text-xs text-ink-subtle">{count}</span> : null}
    </Link>
  );
}

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
  const tab = param(sp, "tab") === "clients" ? "clients" : "team";
  const q = param(sp, "q")?.trim() || undefined;
  const personaParam = param(sp, "persona");
  const persona =
    tab === "team" && personaParam && (TEAM_PERSONA_FILTERS as readonly string[]).includes(personaParam) ? (personaParam as TeamPersonaFilter) : undefined;
  const status = param(sp, "status") ?? "active";
  const active = status === "all" ? undefined : status === "inactive" ? "0" : "1";

  const tz = ctx.settings.timezone;
  const view = await load(() => getSettingsView(db, ctx));
  const settings = view.settings;
  const primaryOwnerId = settings.primaryOwnerUserId ?? null;
  const everyone = (await load(() => listUsers(db, ctx, { q, active }))).filter(isProfile);
  const teamAll = everyone.filter((u) => (STAFF_ROLES as readonly string[]).includes(u.role));
  const clientUsers = everyone.filter((u) => u.role === "client");
  const users = tab === "clients" ? clientUsers : persona ? teamAll.filter((u) => personaOfUser(u) === persona) : teamAll;
  const teams = await teamsByUser(
    db,
    ctx,
    users.map((u) => u.id),
  );
  const allClients = await load(() => listClients(db, ctx, { includeArchived: true }));
  const clientNames = new Map(allClients.map((c) => [c.client.id, c.client.name]));
  const portalClients = allClients
    .filter((c) => c.client.portalEnabled && c.client.archivedAt === null)
    .map((c) => ({ id: c.client.id, name: c.client.name }));
  const canInvite = allowed(ctx, "user.invite");
  // One-time post-migration card (docs/ROLES.md §1.5); null on fresh organisations.
  const notice = await load(() => getRolesNotice(db, ctx));
  const filtered = Boolean(q || persona || status !== "active");
  const capacityOf = (u: UserProfile) => u.capacityHoursPerWeek ?? settings.defaultCapacityHoursPerWeek;
  const tabHref = (t: "team" | "clients") => (t === "clients" ? "/settings/users?tab=clients" : "/settings/users");

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Settings"
        title="Users"
        description="Your photographers, editors and client portal users. Deactivated people keep their history; nothing is ever deleted."
        meta={
          <Badge variant="neutral" className="numeric">
            {users.length}
          </Badge>
        }
      />
      {notice ? <RolesMigrationNotice {...notice} /> : null}
      <nav aria-label="User lists" className="flex gap-5 border-b border-border">
        <TabLink href={tabHref("team")} active={tab === "team"} count={teamAll.length}>
          <Users aria-hidden="true" className="size-4" /> Team
        </TabLink>
        <TabLink href={tabHref("clients")} active={tab === "clients"} count={clientUsers.length}>
          <Store aria-hidden="true" className="size-4" /> Client portal users
        </TabLink>
      </nav>
      <UsersToolbar
        tab={tab}
        canInvite={canInvite}
        defaultCapacity={settings.defaultCapacityHoursPerWeek}
        studioName={view.organisation.name}
        portalClients={portalClients}
      />

      {users.length === 0 ? (
        <Card>
          {filtered ? (
            <EmptyState
              icon={SearchX}
              title="No one matches these filters"
              description="Try another name, role or status — deactivated people are under “Deactivated”."
              action={
                <Button variant="outline" href={tabHref(tab)}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={tab === "clients" ? Store : Users}
              title={tab === "clients" ? "No client portal users yet" : "No users yet"}
              description={
                tab === "clients"
                  ? "Turn on the portal on a client's page, then invite the people who work for them. They only see work you share."
                  : "Invite your photographers and editors to start assigning work."
              }
              action={
                canInvite ? (
                  <Button
                    href={tab === "clients" ? "/settings/users?tab=clients&invite=client" : "/settings/users?invite=1"}
                    leadingIcon={<UserPlus aria-hidden="true" />}
                  >
                    {tab === "clients" ? "Invite client user" : "Invite someone"}
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
                      <RoleCell user={u} isPrimaryOwner={u.id === primaryOwnerId} clientName={u.clientId ? clientNames.get(u.clientId) : null} />
                    </TD>
                    <TD>
                      <TeamList teams={teams.get(u.id) ?? []} />
                    </TD>
                    <TD numeric>
                      {u.role === "client" ? (
                        <span className="text-ink-subtle">—</span>
                      ) : (
                        <>
                          <span className="text-ink">{capacityOf(u)}</span>
                          <span className="text-ink-subtle"> h</span>
                          {u.capacityHoursPerWeek === null ? <span className="block text-2xs text-ink-subtle">default</span> : null}
                        </>
                      )}
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
                      <span className="font-medium text-ink-secondary">
                        {personaLabel(u)}
                        {u.id === primaryOwnerId ? " · Owner" : ""}
                        {u.role === "client" && u.clientId ? ` · ${clientNames.get(u.clientId) ?? ""}` : ""}
                      </span>
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
