import type { Metadata } from "next";
import Link from "next/link";
import { Camera, ChevronRight, SearchX, Store, UserPlus, Users, Wand2 } from "lucide-react";
import { PageContainer } from "@/components/shell/page-container";
import { PeopleToolbar } from "@/components/settings/people-toolbar";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { PHOTOGRAPHER_PRESET_META, photographerPresetOf, type Role } from "@/lib/constants";
import { formatDateTime, formatRelative } from "@/lib/dates";
import type { ReducedUser, UserProfile } from "@/lib/types";
import { listClients } from "@/server/queries/clients";
import { getSettingsView } from "@/server/queries/settings";
import { listUsers } from "@/server/queries/users";
import { allowed, guard, load, pageContext, param } from "@/server/page";

export const metadata: Metadata = { title: "People" };

function isProfile(u: UserProfile | ReducedUser): u is UserProfile {
  return "email" in u;
}

/** The three roles (docs/SIMPLIFICATION-PLAN.md §2), one card each. */
const ROLE_CARDS: { role: Role; title: string; body: string; icon: typeof Camera; invite: string }[] = [
  { role: "photographer", title: "Photographers", body: "Shoot, create jobs, give them to editors and check the edits. The owner sees everything.", icon: Camera, invite: "1" },
  { role: "editor", title: "Editors", body: "Edit the jobs given to them, send them for checking and fix changes.", icon: Wand2, invite: "editor" },
  { role: "client", title: "Clients", body: "Portal users who see progress and the finished photos for their own work.", icon: Store, invite: "client" },
];

/** Plain words for what a person is (plan §2). */
function roleLabel(u: UserProfile, primaryOwnerId: string | null, clientName: string | null): { label: string; variant: "solid" | "info" | "neutral" | "outline" | "warning" } {
  if (u.role === "client") return { label: clientName ? `Client · ${clientName}` : "Client", variant: "outline" };
  if (u.role === "editor") return { label: u.canCreateJobs ? "Editor · adds own jobs" : "Editor", variant: "neutral" };
  if (u.id === primaryOwnerId) return { label: "Owner", variant: "solid" };
  const preset = photographerPresetOf(u);
  if (preset === "co_owner") return { label: "Co-owner", variant: "solid" };
  if (preset === "own_shoots") return { label: `Photographer · ${PHOTOGRAPHER_PRESET_META.own_shoots.label.toLowerCase()}`, variant: "info" };
  return { label: "Photographer · custom", variant: "warning" };
}

/** Settings → People (plan §3, §8 "Kept"): three role cards, the list, invite, deactivate with "move their jobs to…". */
export default async function PeoplePage({ searchParams }: PageProps<"/settings/people">) {
  const { ctx, db } = await pageContext();
  guard(ctx, "settings.view");
  const sp = await searchParams;
  const q = param(sp, "q")?.trim() || undefined;
  const status = param(sp, "status") === "inactive" ? "inactive" : "active";
  const roleFilter = param(sp, "role");
  const tz = ctx.settings.timezone;

  const view = await load(() => getSettingsView(db, ctx));
  const primaryOwnerId = view.settings.primaryOwnerUserId ?? null;
  const everyone = (await load(() => listUsers(db, ctx, { q, active: status === "inactive" ? "0" : "1" }))).filter(isProfile);
  const allActive = status === "active" && !q ? everyone : (await load(() => listUsers(db, ctx, { active: "1" }))).filter(isProfile);
  const counts: Record<Role, number> = {
    photographer: allActive.filter((u) => u.role === "photographer").length,
    editor: allActive.filter((u) => u.role === "editor").length,
    client: allActive.filter((u) => u.role === "client").length,
  };
  const people = roleFilter === "photographer" || roleFilter === "editor" || roleFilter === "client" ? everyone.filter((u) => u.role === roleFilter) : everyone;

  const allClients = await load(() => listClients(db, ctx, { includeArchived: true }));
  const clientNames = new Map(allClients.map((c) => [c.client.id, c.client.name]));
  const portalClients = allClients.filter((c) => c.client.portalEnabled && c.client.archivedAt === null).map((c) => ({ id: c.client.id, name: c.client.name }));
  const canInvite = allowed(ctx, "user.invite");
  const filtered = Boolean(q || roleFilter || status !== "active");

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Settings"
        title="People"
        description="Who works with you. Deactivated people keep their history; nothing is ever deleted."
        meta={
          <Badge variant="neutral" className="numeric">
            {people.length}
          </Badge>
        }
      />

      <ul className="grid gap-3 sm:grid-cols-3" aria-label="Roles">
        {ROLE_CARDS.map((card) => {
          const Icon = card.icon;
          const active = roleFilter === card.role;
          return (
            <li key={card.role}>
              <Link
                href={active ? "/settings/people" : `/settings/people?role=${card.role}`}
                aria-pressed={active}
                data-role-filter={card.role}
                className={`flex h-full flex-col gap-2 rounded-lg border p-4 text-left shadow-xs transition-colors duration-(--motion-fast) focus-ring ${
                  active ? "border-accent bg-accent-soft/40" : "border-border bg-surface hover:border-border-hover"
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                    <Icon aria-hidden="true" className={active ? "size-4 text-accent-ink" : "size-4 text-ink-subtle"} />
                    {card.title}
                  </span>
                  <span className="numeric text-lg font-semibold text-ink">{counts[card.role]}</span>
                </span>
                <span className="text-xs text-ink-muted">{card.body}</span>
              </Link>
            </li>
          );
        })}
      </ul>

      <PeopleToolbar canInvite={canInvite} studioName={view.organisation.name} portalClients={portalClients} />

      {people.length === 0 ? (
        <Card>
          {filtered ? (
            <EmptyState
              icon={SearchX}
              title="No one matches"
              description="Try another name, or switch between Active and Deactivated."
              action={
                <Button variant="outline" href="/settings/people">
                  Show everyone
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Users}
              title="Just you so far"
              description="Invite an editor to give jobs to, or another photographer who shoots with you."
              action={
                canInvite ? (
                  <Button href="/settings/people?invite=editor" leadingIcon={<UserPlus aria-hidden="true" />}>
                    Invite an editor
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
                  <TH>Status</TH>
                  <TH>Last signed in</TH>
                  <TH shrink>
                    <span className="sr-only">Open</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {people.map((u) => {
                  const r = roleLabel(u, primaryOwnerId, u.clientId ? (clientNames.get(u.clientId) ?? null) : null);
                  return (
                    <TR key={u.id} className="group">
                      <TD>
                        <Link href={`/settings/people/${u.id}`} className="flex min-w-0 items-center gap-3 rounded-sm focus-ring">
                          <Avatar name={u.name} colour={u.avatarColour} size="md" className={u.isActive ? undefined : "opacity-50 grayscale"} />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-ink group-hover:text-accent-ink">
                              {u.name}
                              {u.id === ctx.userId ? <span className="ml-1.5 text-xs font-normal text-ink-muted">(you)</span> : null}
                            </span>
                            <span className="block truncate text-xs text-ink-muted">{u.email}</span>
                          </span>
                        </Link>
                      </TD>
                      <TD>
                        <Badge variant={r.variant} size="sm">
                          {r.label}
                        </Badge>
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
                          href={`/settings/people/${u.id}`}
                          aria-label={`Open ${u.name}`}
                          className="flex size-7 items-center justify-center rounded-sm text-ink-subtle hover:bg-surface-muted hover:text-ink focus-ring"
                        >
                          <ChevronRight aria-hidden="true" className="size-4" />
                        </Link>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </Card>

          {/* Phone cards */}
          <ul className="flex flex-col gap-2 md:hidden">
            {people.map((u) => {
              const r = roleLabel(u, primaryOwnerId, u.clientId ? (clientNames.get(u.clientId) ?? null) : null);
              return (
                <li key={u.id}>
                  <Link
                    href={`/settings/people/${u.id}`}
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
                        <span className="font-medium text-ink-secondary">{r.label}</span>
                        <span aria-hidden="true">·</span>
                        <span>{u.lastLoginAt ? `Seen ${formatRelative(u.lastLoginAt)}` : "Never signed in"}</span>
                      </p>
                    </div>
                    <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-subtle" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </PageContainer>
  );
}
