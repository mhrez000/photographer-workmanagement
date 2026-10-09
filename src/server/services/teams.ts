/**
 * Teams service (ARCHITECTURE.md §2.1 teams / team_memberships, §5 team.*).
 * `team.manage` = owner / manager. Memberships are a LEDGER: adding inserts a
 * row, removing fills `left_at` + `removed_by_user_id` once; rows are never
 * deleted. Archiving a team leaves memberships untouched — "active
 * teammates" already exclude archived teams.
 */
import { and, eq, isNull } from "drizzle-orm";
import { teamMemberships, teams } from "@/db/schema";
import type { AuthContext, Team, TeamMembership, User } from "@/lib/types";
import { ArchiveTeamInput, CreateTeamInput, TeamMemberInput, UpdateTeamInput } from "@/lib/validation/teams";
import { recordEvent } from "@/server/audit";
import { assertCan } from "@/server/auth/permissions";
import { loadTeamInOrg, loadUserInOrg, loadUsersInOrg, parseInput, type DbLike, type Tx } from "./_shared";
import { checkVersion, diffFields, ruleViolation } from "./_admin";

function assertNameFree(db: DbLike, ctx: AuthContext, name: string, exceptTeamId?: string): void {
  const rows = db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.organisationId, ctx.organisationId)).all();
  const clash = rows.find((r) => r.name.trim().toLowerCase() === name.trim().toLowerCase() && r.id !== exceptTeamId);
  if (clash) throw ruleViolation("A team with this name already exists", {}, "name");
}

function assertActiveUser(user: User, field: string): void {
  if (!user.isActive) throw ruleViolation(`${user.name} is deactivated`, {}, field);
}

function openMembership(db: DbLike, teamId: string, userId: string): TeamMembership | undefined {
  return db
    .select()
    .from(teamMemberships)
    .where(and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.userId, userId), isNull(teamMemberships.leftAt)))
    .get();
}

function insertMembership(tx: Tx, ctx: AuthContext, team: Team, user: User): TeamMembership {
  const now = ctx.now();
  const row = tx
    .insert(teamMemberships)
    .values({ organisationId: ctx.organisationId, teamId: team.id, userId: user.id, addedByUserId: ctx.userId, joinedAt: now })
    .returning()
    .get();
  recordEvent(tx, ctx, {
    entityType: "team",
    entityId: team.id,
    eventType: "team.member_added",
    action: "created",
    previousValue: null,
    newValue: { userId: user.id, userName: user.name },
    metadata: { membershipId: row.id, teamName: team.name },
  });
  return row;
}

/** Active members (left_at IS NULL) of a team. */
export function teamMemberIds(db: DbLike, teamId: string): string[] {
  return db
    .select({ userId: teamMemberships.userId })
    .from(teamMemberships)
    .where(and(eq(teamMemberships.teamId, teamId), isNull(teamMemberships.leftAt)))
    .all()
    .map((r) => r.userId);
}

export interface TeamWithMembers {
  team: Team;
  memberIds: string[];
}

/** Creates a team; the lead (if any) is added as a member too. */
export function createTeam(tx: Tx, ctx: AuthContext, input: unknown): TeamWithMembers {
  assertCan(ctx, "team.manage");
  const data = parseInput(CreateTeamInput, input);
  assertNameFree(tx, ctx, data.name);
  const lead = data.leadUserId ? loadUserInOrg(tx, ctx, data.leadUserId) : null;
  if (lead) assertActiveUser(lead, "leadUserId");
  const memberIds = Array.from(new Set([...(data.memberIds ?? []), ...(lead ? [lead.id] : [])]));
  const members = loadUsersInOrg(tx, ctx, memberIds);
  for (const m of members) assertActiveUser(m, "memberIds");

  const now = ctx.now();
  const team = tx
    .insert(teams)
    .values({
      organisationId: ctx.organisationId,
      name: data.name,
      description: data.description ?? null,
      leadUserId: lead?.id ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  recordEvent(tx, ctx, {
    entityType: "team",
    entityId: team.id,
    eventType: "team.created",
    action: "created",
    previousValue: null,
    newValue: { name: team.name, description: team.description, leadUserId: team.leadUserId, memberIds },
    metadata: { teamId: team.id },
  });
  const byId = new Map(members.map((m) => [m.id, m]));
  for (const id of memberIds) insertMembership(tx, ctx, team, byId.get(id) as User);
  return { team, memberIds };
}

export function updateTeam(tx: Tx, ctx: AuthContext, input: unknown): Team {
  assertCan(ctx, "team.manage");
  const data = parseInput(UpdateTeamInput, input);
  const team = loadTeamInOrg(tx, ctx, data.teamId);
  checkVersion(team, data.expectedVersion, team);
  if (team.archivedAt) throw ruleViolation("This team is archived");
  if (data.name !== undefined) assertNameFree(tx, ctx, data.name, team.id);
  const diff = diffFields(team, data, ["name", "description", "leadUserId"] as const);
  if (diff.changed.length === 0) return team;
  const meta: Record<string, unknown> = { teamId: team.id };
  if (diff.changed.includes("leadUserId") && diff.set.leadUserId) {
    const lead = loadUserInOrg(tx, ctx, diff.set.leadUserId);
    assertActiveUser(lead, "leadUserId");
    meta.leadName = lead.name;
  }
  const row = tx
    .update(teams)
    .set({ ...diff.set, updatedAt: ctx.now(), version: team.version + 1 })
    .where(eq(teams.id, team.id))
    .returning()
    .get();
  recordEvent(tx, ctx, {
    entityType: "team",
    entityId: team.id,
    eventType: "team.updated",
    action: "updated",
    previousValue: diff.previous,
    newValue: diff.next,
    metadata: { ...meta, name: row.name },
  });
  // A new lead joins the team if they are not a member yet.
  if (diff.set.leadUserId && !openMembership(tx, team.id, diff.set.leadUserId)) {
    insertMembership(tx, ctx, row, loadUserInOrg(tx, ctx, diff.set.leadUserId));
  }
  return row;
}

export function archiveTeam(tx: Tx, ctx: AuthContext, input: unknown): Team {
  assertCan(ctx, "team.manage");
  const data = parseInput(ArchiveTeamInput, input);
  const team = loadTeamInOrg(tx, ctx, data.teamId);
  checkVersion(team, data.expectedVersion, team);
  if (team.archivedAt) throw ruleViolation("This team is already archived");
  const now = ctx.now();
  const row = tx
    .update(teams)
    .set({ archivedAt: now, updatedAt: now, version: team.version + 1 })
    .where(eq(teams.id, team.id))
    .returning()
    .get();
  recordEvent(tx, ctx, {
    entityType: "team",
    entityId: team.id,
    eventType: "team.archived",
    action: "archived",
    previousValue: { archivedAt: null, name: team.name },
    newValue: { archivedAt: now, name: team.name },
    metadata: { teamId: team.id, memberIds: teamMemberIds(tx, team.id) },
  });
  return row;
}

export function addMember(tx: Tx, ctx: AuthContext, input: unknown): TeamMembership {
  assertCan(ctx, "team.manage");
  const data = parseInput(TeamMemberInput, input);
  const team = loadTeamInOrg(tx, ctx, data.teamId);
  if (team.archivedAt) throw ruleViolation("This team is archived");
  const user = loadUserInOrg(tx, ctx, data.userId);
  assertActiveUser(user, "userId");
  if (openMembership(tx, team.id, user.id)) throw ruleViolation(`${user.name} is already in this team`, {}, "userId");
  return insertMembership(tx, ctx, team, user);
}

/** Ends the membership (fill-once `left_at`); clears the lead if they were the lead. */
export function removeMember(tx: Tx, ctx: AuthContext, input: unknown): TeamMembership {
  assertCan(ctx, "team.manage");
  const data = parseInput(TeamMemberInput, input);
  const team = loadTeamInOrg(tx, ctx, data.teamId);
  const user = loadUserInOrg(tx, ctx, data.userId);
  const membership = openMembership(tx, team.id, user.id);
  if (!membership) throw ruleViolation(`${user.name} is not a member of this team`, {}, "userId");
  const now = ctx.now();
  const row = tx
    .update(teamMemberships)
    .set({ leftAt: now, removedByUserId: ctx.userId })
    .where(eq(teamMemberships.id, membership.id))
    .returning()
    .get();
  const leadCleared = team.leadUserId === user.id;
  if (leadCleared) {
    tx.update(teams).set({ leadUserId: null, updatedAt: now, version: team.version + 1 }).where(eq(teams.id, team.id)).run();
  }
  recordEvent(tx, ctx, {
    entityType: "team",
    entityId: team.id,
    eventType: "team.member_removed",
    action: "removed",
    previousValue: { userId: user.id, userName: user.name, joinedAt: membership.joinedAt },
    newValue: null,
    metadata: { membershipId: membership.id, teamName: team.name, leadCleared },
  });
  return row;
}
