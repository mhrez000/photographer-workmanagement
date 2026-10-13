/**
 * Settings reads for the simplified app (docs/SIMPLIFICATION-PLAN.md §2, §8):
 *
 *   getPeopleOverview  People as three plain cards (Owners · Photographers ·
 *                      Editors) with the invite choice per photographer
 *                      ("Only their own shoots" / "Everything (co-owner)" /
 *                      "Custom") and "Can add their own jobs" per editor
 *   getStudioHistory   Settings → History = the studio-wide activity feed
 *   getAdvancedState   the Advanced tools switch (+ whether the studio relies
 *                      on advanced features, which forces it on)
 *
 * All three are owner-only (`settings.view`); clients and editors → 403.
 */
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import type { DbLike } from "@/db/index";
import { automations, clients, users, workflows } from "@/db/schema";
import { MEMBER_FLAGS, type MemberFlag } from "@/lib/constants";
import type { ActivityFeedItem, AdvancedState, AuthContext, Paginated, PeopleOverview, PersonCard, PhotographerPreset, User } from "@/lib/types";
import { assertCan, can } from "@/server/auth/permissions";
import { listActivity } from "./activity";
import { binaryAsc } from "./metrics";
import { loadAdvancedToolsEnabled, loadUsualCapacities } from "./simpleColumns";
import { primaryOwnerIdOf } from "./users";

/** The six switches of the "Only their own shoots" preset (plan §2, §12.4). */
export const OWN_SHOOTS_PRESET: Readonly<Record<MemberFlag, boolean>> = {
  canCreateJobs: true,
  canAssignEditors: true,
  canReviewSubmissions: true,
  canViewTeamWorkloads: false,
  canViewAllJobs: false,
  canViewAnalytics: false,
};

/** The invite choice a photographer's switches amount to; admins are "everything", any other mix is "custom". */
export function photographerPreset(user: Pick<User, "isAdmin"> & Partial<Record<MemberFlag, boolean>>): PhotographerPreset {
  if (user.isAdmin) return "everything";
  return MEMBER_FLAGS.every((f) => (user[f] ?? false) === OWN_SHOOTS_PRESET[f]) ? "own_shoots" : "custom";
}

function personCard(u: User, primaryOwnerId: string | null, usualCapacity: number | null): PersonCard {
  return {
    user: { id: u.id, name: u.name, role: u.role, avatarColour: u.avatarColour, isActive: u.isActive, isAdmin: u.isAdmin, isPrimaryOwner: u.id === primaryOwnerId, title: u.title },
    email: u.email,
    isPrimaryOwner: u.id === primaryOwnerId,
    preset: u.role === "photographer" ? photographerPreset(u) : null,
    canCreateJobs: u.role === "editor" ? u.canCreateJobs : null,
    usualCapacity,
  };
}

/** Settings → People (owner only): three cards + the client portal count. */
export async function getPeopleOverview(db: DbLike, ctx: AuthContext): Promise<PeopleOverview> {
  assertCan(ctx, "settings.view");
  const staff = await db
    .select()
    .from(users)
    .where(and(eq(users.organisationId, ctx.organisationId), ne(users.role, "client")))
    .orderBy(binaryAsc(users.name), asc(users.id));
  const primary = await primaryOwnerIdOf(db, ctx);
  const capacities = await loadUsualCapacities(
    db,
    ctx,
    staff.filter((u) => u.role === "editor").map((u) => u.id),
  );
  const cards = staff.map((u) => personCard(u, primary, capacities.get(u.id) ?? null));
  const clientRows = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number), portal: sql<number>`sum(case when ${clients.portalEnabled} then 1 else 0 end)`.mapWith(Number) })
    .from(clients)
    .where(and(eq(clients.organisationId, ctx.organisationId), isNull(clients.archivedAt)));
  return {
    owners: cards.filter((c) => c.user.role === "photographer" && c.user.isAdmin === true),
    photographers: cards.filter((c) => c.user.role === "photographer" && c.user.isAdmin !== true),
    editors: cards.filter((c) => c.user.role === "editor"),
    clients: { withPortal: clientRows[0]?.portal || 0, total: clientRows[0]?.n || 0 },
  };
}

/** Settings → History (owner only): the studio-wide feed (`listActivity` filters / cursor). */
export async function getStudioHistory(db: DbLike, ctx: AuthContext, input: unknown = {}): Promise<Paginated<ActivityFeedItem>> {
  assertCan(ctx, "settings.view");
  return listActivity(db, ctx, input);
}

/** The Advanced tools switch and whether the studio relies on advanced features (owner only). */
export async function getAdvancedState(db: DbLike, ctx: AuthContext): Promise<AdvancedState> {
  assertCan(ctx, "settings.view");
  const stored = await loadAdvancedToolsEnabled(db, ctx);
  const customWorkflows = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(workflows)
    .where(and(eq(workflows.organisationId, ctx.organisationId), eq(workflows.isDefault, false), isNull(workflows.archivedAt)));
  const liveAutomations = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(automations)
    .where(and(eq(automations.organisationId, ctx.organisationId), eq(automations.isEnabled, true), isNull(automations.archivedAt)));
  const forcedReasons: string[] = [];
  if ((customWorkflows[0]?.n || 0) > 0) forcedReasons.push("custom_workflows");
  if (ctx.settings.automationsEnabled && (liveAutomations[0]?.n || 0) > 0) forcedReasons.push("automations");
  const forcedOn = forcedReasons.length > 0;
  return {
    enabled: stored.enabled,
    columnPresent: stored.present,
    forcedOn,
    forcedReasons,
    effective: stored.enabled || forcedOn,
    canManage: can(ctx, "settings.manage"),
  };
}
