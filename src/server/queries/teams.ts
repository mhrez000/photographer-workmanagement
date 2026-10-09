/**
 * Teams (ARCHITECTURE.md §2.1 teams / team_memberships, §10 `/settings/teams`).
 *
 * team.view_members (everyone): non-archived teams with their current
 * members (UserRef only). team.manage (O/M): archived teams on request and
 * the full membership ledger (joined/left, added/removed by).
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "@/db/index";
import { teamMemberships, teams, users } from "@/db/schema";
import type { AuthContext, TeamDetail, TeamMembershipView, TeamRef, TeamView, UserRef } from "@/lib/types";
import { assertCan, can } from "@/server/auth/permissions";
import { NotFoundError } from "@/server/errors";
import { loadTeamInOrg, parseInput } from "@/server/services/_shared";
import { loadUserRefs } from "./metrics";

const flag = z.preprocess((v) => (Array.isArray(v) ? v[0] : v), z.union([z.boolean(), z.enum(["1", "0", "true", "false"])]).optional()).transform(
  (v) => v === true || v === "1" || v === "true",
);

export const TeamListFiltersSchema = z.object({ includeArchived: flag });

/** Current members (left_at IS NULL) per team id. */
function currentMembers(db: DbLike, ctx: AuthContext, teamIds: readonly string[]): Map<string, UserRef[]> {
  const out = new Map<string, UserRef[]>();
  if (teamIds.length === 0) return out;
  const rows = db
    .select({
      teamId: teamMemberships.teamId,
      id: users.id,
      name: users.name,
      role: users.role,
      avatarColour: users.avatarColour,
      isActive: users.isActive,
    })
    .from(teamMemberships)
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .where(and(eq(teamMemberships.organisationId, ctx.organisationId), inArray(teamMemberships.teamId, [...teamIds]), isNull(teamMemberships.leftAt)))
    .orderBy(asc(users.name))
    .all();
  for (const { teamId, ...u } of rows) {
    const list = out.get(teamId) ?? [];
    list.push(u);
    out.set(teamId, list);
  }
  return out;
}

/** `GET /api/teams?includeArchived` (archived only with team.manage). */
export function listTeams(db: DbLike, ctx: AuthContext, input: unknown = {}): TeamView[] {
  assertCan(ctx, "team.view_members");
  const f = parseInput(TeamListFiltersSchema, input ?? {});
  const withArchived = f.includeArchived && can(ctx, "team.manage");
  const rows = db
    .select()
    .from(teams)
    .where(and(eq(teams.organisationId, ctx.organisationId), withArchived ? undefined : isNull(teams.archivedAt)))
    .orderBy(asc(teams.name))
    .all();
  const members = currentMembers(
    db,
    ctx,
    rows.map((t) => t.id),
  );
  const leads = loadUserRefs(
    db,
    ctx,
    rows.map((t) => t.leadUserId),
  );
  return rows.map((t) => {
    const m = members.get(t.id) ?? [];
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      lead: t.leadUserId ? (leads.get(t.leadUserId) ?? null) : null,
      archivedAt: t.archivedAt,
      version: t.version,
      members: m,
      memberCount: m.length,
    };
  });
}

/** `GET /api/teams/:id`. Archived teams look missing without team.manage. */
export function getTeamDetail(db: DbLike, ctx: AuthContext, teamId: string): TeamDetail {
  assertCan(ctx, "team.view_members");
  const team = loadTeamInOrg(db, ctx, teamId);
  const manage = can(ctx, "team.manage");
  if (team.archivedAt !== null && !manage) throw new NotFoundError("Team");
  const members = currentMembers(db, ctx, [team.id]).get(team.id) ?? [];
  let memberships: TeamMembershipView[] = [];
  if (manage) {
    const rows = db
      .select()
      .from(teamMemberships)
      .where(and(eq(teamMemberships.organisationId, ctx.organisationId), eq(teamMemberships.teamId, team.id)))
      .orderBy(asc(teamMemberships.joinedAt))
      .all();
    const refs = loadUserRefs(
      db,
      ctx,
      rows.flatMap((r) => [r.userId, r.addedByUserId, r.removedByUserId]),
    );
    memberships = rows.flatMap((r) => {
      const user = refs.get(r.userId);
      if (!user) return [];
      return [
        {
          id: r.id,
          user,
          joinedAt: r.joinedAt,
          leftAt: r.leftAt,
          addedBy: r.addedByUserId ? (refs.get(r.addedByUserId) ?? null) : null,
          removedBy: r.removedByUserId ? (refs.get(r.removedByUserId) ?? null) : null,
        },
      ];
    });
  }
  const lead = team.leadUserId ? (loadUserRefs(db, ctx, [team.leadUserId]).get(team.leadUserId) ?? null) : null;
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    lead,
    archivedAt: team.archivedAt,
    version: team.version,
    members,
    memberCount: members.length,
    memberships,
  };
}

/** Active (non-archived) team refs per user id — for directories and user detail. */
export function teamsByUser(db: DbLike, ctx: AuthContext, userIds?: readonly string[]): Map<string, TeamRef[]> {
  const rows = db
    .select({ userId: teamMemberships.userId, id: teams.id, name: teams.name })
    .from(teamMemberships)
    .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
    .where(
      and(
        eq(teamMemberships.organisationId, ctx.organisationId),
        isNull(teamMemberships.leftAt),
        isNull(teams.archivedAt),
        userIds ? inArray(teamMemberships.userId, [...userIds]) : undefined,
      ),
    )
    .orderBy(asc(teams.name))
    .all();
  const out = new Map<string, TeamRef[]>();
  for (const r of rows) {
    const list = out.get(r.userId) ?? [];
    list.push({ id: r.id, name: r.name });
    out.set(r.userId, list);
  }
  return out;
}
