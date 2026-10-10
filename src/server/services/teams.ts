/**
 * Teams service (ARCHITECTURE.md §2.1 teams / team_memberships, §5 team.*).
 * `team.manage` = admins (docs/ROLES.md §3.3). Memberships are a LEDGER:
 * adding inserts a row, removing fills `left_at` + `removed_by_user_id` once;
 * rows are never deleted. Archiving a team leaves memberships untouched —
 * "active teammates" already exclude archived teams.
 *
 * Roles v2: teams only GROUP people (filters, settings); they no longer drive
 * job visibility. Members and leads are allow-listed (§3.4): in-org, active,
 * role ∈ STAFF_ROLES — a client user → 422.
 */
import { and, eq, isNull } from "drizzle-orm";
import { teamMemberships, teams } from "@/db/schema";
import { STAFF_ROLES, type Role } from "@/lib/constants";
import type { AuthContext, Team, TeamMembership, User } from "@/lib/types";
import { ArchiveTeamInput, CreateTeamInput, TeamMemberInput, UpdateTeamInput } from "@/lib/validation/teams";
import { recordEvent } from "@/server/audit";
import { assertCan } from "@/server/auth/permissions";
import { first, loadTeamInOrg, one, loadUserInOrg, loadUsersInOrg, parseInput, type DbLike, type Tx } from "./_shared";
import { UserRuleError, checkVersion, diffFields, ruleViolation } from "./_admin";

async function assertNameFree(db: DbLike, ctx: AuthContext, name: string, exceptTeamId?: string): Promise<void> {
  const rows = await db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.organisationId, ctx.organisationId));
  const clash = rows.find((r) => r.name.trim().toLowerCase() === name.trim().toLowerCase() && r.id !== exceptTeamId);
  if (clash) throw ruleViolation("A team with this name already exists", {}, "name");
}

/** Allow-list for members and leads (§3.4): active staff (photographer or editor) of the organisation. */
function assertActiveUser(user: User, field: string): void {
  if (!(STAFF_ROLES as readonly Role[]).includes(user.role)) {
    throw new UserRuleError("not_staff", `${user.name} is a client portal user and can't join a team`, field);
  }
  if (!user.isActive) throw ruleViolation(`${user.name} is deactivated`, {}, field);
}

async function openMembership(db: DbLike, teamId: string, userId: string): Promise<TeamMembership | undefined> {
  return first(
    db
      .select()
      .from(teamMemberships)
      .where(and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.userId, userId), isNull(teamMemberships.leftAt)))
      .limit(1),
  );
}

async function insertMembership(tx: Tx, ctx: AuthContext, team: Team, user: User): Promise<TeamMembership> {
  const now = ctx.now();
  const row = await one(
    tx
      .insert(teamMemberships)
      .values({ organisationId: ctx.organisationId, teamId: team.id, userId: user.id, addedByUserId: ctx.userId, joinedAt: now })
      .returning(),
  );
  await recordEvent(tx, ctx, {
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
export async function teamMemberIds(db: DbLike, teamId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: teamMemberships.userId })
    .from(teamMemberships)
    .where(and(eq(teamMemberships.teamId, teamId), isNull(teamMemberships.leftAt)))
    .orderBy(teamMemberships.joinedAt, teamMemberships.id);
  return rows.map((r) => r.userId);
}

export interface TeamWithMembers {
  team: Team;
  memberIds: string[];
}

/** Creates a team; the lead (if any) is added as a member too. */
export async function createTeam(tx: Tx, ctx: AuthContext, input: unknown): Promise<TeamWithMembers> {
  assertCan(ctx, "team.manage");
  const data = parseInput(CreateTeamInput, input);
  await assertNameFree(tx, ctx, data.name);
  const lead = data.leadUserId ? await loadUserInOrg(tx, ctx, data.leadUserId) : null;
  if (lead) assertActiveUser(lead, "leadUserId");
  const memberIds = Array.from(new Set([...(data.memberIds ?? []), ...(lead ? [lead.id] : [])]));
  const members = await loadUsersInOrg(tx, ctx, memberIds);
  for (const m of members) assertActiveUser(m, "memberIds");

  const now = ctx.now();
  const team = await one(
    tx
      .insert(teams)
      .values({
        organisationId: ctx.organisationId,
        name: data.name,
        description: data.description ?? null,
        leadUserId: lead?.id ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning(),
  );
  await recordEvent(tx, ctx, {
    entityType: "team",
    entityId: team.id,
    eventType: "team.created",
    action: "created",
    previousValue: null,
    newValue: { name: team.name, description: team.description, leadUserId: team.leadUserId, memberIds },
    metadata: { teamId: team.id },
  });
  const byId = new Map(members.map((m) => [m.id, m]));
  for (const id of memberIds) await insertMembership(tx, ctx, team, byId.get(id) as User);
  return { team, memberIds };
}

export async function updateTeam(tx: Tx, ctx: AuthContext, input: unknown): Promise<Team> {
  assertCan(ctx, "team.manage");
  const data = parseInput(UpdateTeamInput, input);
  const team = await loadTeamInOrg(tx, ctx, data.teamId);
  checkVersion(team, data.expectedVersion, team);
  if (team.archivedAt) throw ruleViolation("This team is archived");
  if (data.name !== undefined) await assertNameFree(tx, ctx, data.name, team.id);
  const diff = diffFields(team, data, ["name", "description", "leadUserId"] as const);
  if (diff.changed.length === 0) return team;
  const meta: Record<string, unknown> = { teamId: team.id };
  if (diff.changed.includes("leadUserId") && diff.set.leadUserId) {
    const lead = await loadUserInOrg(tx, ctx, diff.set.leadUserId);
    assertActiveUser(lead, "leadUserId");
    meta.leadName = lead.name;
  }
  const row = await one(
    tx
      .update(teams)
      .set({ ...diff.set, updatedAt: ctx.now(), version: team.version + 1 })
      .where(eq(teams.id, team.id))
      .returning(),
  );
  await recordEvent(tx, ctx, {
    entityType: "team",
    entityId: team.id,
    eventType: "team.updated",
    action: "updated",
    previousValue: diff.previous,
    newValue: diff.next,
    metadata: { ...meta, name: row.name },
  });
  // A new lead joins the team if they are not a member yet.
  if (diff.set.leadUserId && !(await openMembership(tx, team.id, diff.set.leadUserId))) {
    await insertMembership(tx, ctx, row, await loadUserInOrg(tx, ctx, diff.set.leadUserId));
  }
  return row;
}

export async function archiveTeam(tx: Tx, ctx: AuthContext, input: unknown): Promise<Team> {
  assertCan(ctx, "team.manage");
  const data = parseInput(ArchiveTeamInput, input);
  const team = await loadTeamInOrg(tx, ctx, data.teamId);
  checkVersion(team, data.expectedVersion, team);
  if (team.archivedAt) throw ruleViolation("This team is already archived");
  const now = ctx.now();
  const row = await one(
    tx
      .update(teams)
      .set({ archivedAt: now, updatedAt: now, version: team.version + 1 })
      .where(eq(teams.id, team.id))
      .returning(),
  );
  await recordEvent(tx, ctx, {
    entityType: "team",
    entityId: team.id,
    eventType: "team.archived",
    action: "archived",
    previousValue: { archivedAt: null, name: team.name },
    newValue: { archivedAt: now, name: team.name },
    metadata: { teamId: team.id, memberIds: await teamMemberIds(tx, team.id) },
  });
  return row;
}

export async function addMember(tx: Tx, ctx: AuthContext, input: unknown): Promise<TeamMembership> {
  assertCan(ctx, "team.manage");
  const data = parseInput(TeamMemberInput, input);
  const team = await loadTeamInOrg(tx, ctx, data.teamId);
  if (team.archivedAt) throw ruleViolation("This team is archived");
  const user = await loadUserInOrg(tx, ctx, data.userId);
  assertActiveUser(user, "userId");
  if (await openMembership(tx, team.id, user.id)) throw ruleViolation(`${user.name} is already in this team`, {}, "userId");
  return insertMembership(tx, ctx, team, user);
}

/** Ends the membership (fill-once `left_at`); clears the lead if they were the lead. */
export async function removeMember(tx: Tx, ctx: AuthContext, input: unknown): Promise<TeamMembership> {
  assertCan(ctx, "team.manage");
  const data = parseInput(TeamMemberInput, input);
  const team = await loadTeamInOrg(tx, ctx, data.teamId);
  const user = await loadUserInOrg(tx, ctx, data.userId);
  const membership = await openMembership(tx, team.id, user.id);
  if (!membership) throw ruleViolation(`${user.name} is not a member of this team`, {}, "userId");
  const now = ctx.now();
  const row = await one(tx.update(teamMemberships).set({ leftAt: now, removedByUserId: ctx.userId }).where(eq(teamMemberships.id, membership.id)).returning());
  const leadCleared = team.leadUserId === user.id;
  if (leadCleared) {
    await tx
      .update(teams)
      .set({ leadUserId: null, updatedAt: now, version: team.version + 1 })
      .where(eq(teams.id, team.id));
  }
  await recordEvent(tx, ctx, {
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
