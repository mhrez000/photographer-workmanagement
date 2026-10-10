/**
 * People directories and user detail (ARCHITECTURE.md §3.2 user.view,
 * §10 `/team/photographers`, `/team/editors`, `/team/users/[id]`,
 * `/settings/users`; docs/ROLES.md §2.4, §3.4, §10.2).
 *
 * Projection: admins (and the user themself) get the full safe row
 * (`UserProfile`, never the hash or session version); team members and
 * editors get the reduced projection `id, name, title, role, isAdmin,
 * isPrimaryOwner, avatarColour, isActive` only — never email or phone.
 * Client (portal) users are excluded from every list for non-admins, a
 * client id is a 404 on detail for them, and `?role=client` is a 400.
 * Directory stats follow §10.2 (editor workload counts need ⚑workloads;
 * completed / revision rates and every photographer-peer statistic need
 * analytics). Clients never reach these reads (user.view / team.view_members
 * → 403).
 */
import { and, asc, eq, inArray, isNotNull, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { first, type DbLike } from "@/db/index";
import { jobs, organisationSettings, users } from "@/db/schema";
import { ROLES, STAFF_ROLES } from "@/lib/constants";
import { revisionRate } from "@/lib/metrics";
import type { AuthContext, DirectoryEntry, DirectoryStats, ReducedUser, User, UserDetailView, UserProfile } from "@/lib/types";
import { assertCan, can, isAdmin } from "@/server/auth/permissions";
import { NotFoundError } from "@/server/errors";
import { loadUserInOrg, parseInput, safeUser, userRef } from "@/server/services/_shared";
import { approvedJobsInRange, binaryAsc, groupBy, jobCountsBy, lastDaysRange, loadOrgSettings } from "./metrics";
import { likeSql } from "./scope";
import { teamsByUser } from "./teams";
import { canOpenPersonPage, computeWorkloads, getWorkloadDetail, openJobCountFor } from "./workloads";

const one = <T extends z.ZodType>(item: T) => z.preprocess((v) => (Array.isArray(v) ? v[0] : v === "" ? undefined : v), item);

const activeFilter = one(z.enum(["1", "0", "true", "false"]).optional());
const qFilter = one(z.string().trim().min(1).max(200).optional());

/** Admin filter schema: any role (client portal users included). */
export const UserListFiltersSchema = z.object({
  role: one(z.enum(ROLES).optional()),
  /** "1" active only, "0" inactive only, absent = both. */
  active: activeFilter,
  q: qFilter,
});

/** Team members / editors: staff roles only (`role=client` → 400, §3.4). */
export const StaffUserListFiltersSchema = z.object({
  role: one(z.enum(STAFF_ROLES).optional()),
  active: activeFilter,
  q: qFilter,
});

/** The organisation's primary owner id (null when unset). */
export async function primaryOwnerIdOf(db: DbLike, ctx: AuthContext): Promise<string | null> {
  const row = await first(
    db
      .select({ id: organisationSettings.primaryOwnerUserId })
      .from(organisationSettings)
      .where(eq(organisationSettings.organisationId, ctx.organisationId)),
  );
  return row?.id ?? null;
}

/** The reduced projection (§3.4): no email, phone or other private fields. */
export function reducedUser(row: User, primaryOwnerId: string | null): ReducedUser {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    role: row.role,
    isAdmin: row.isAdmin,
    isPrimaryOwner: row.id === primaryOwnerId,
    avatarColour: row.avatarColour,
    isActive: row.isActive,
  };
}

/** Full safe row for admins / self, the reduced projection otherwise. */
export function projectUser(row: User, ctx: AuthContext, primaryOwnerId: string | null = null): UserProfile | ReducedUser {
  if (isAdmin(ctx) || row.id === ctx.userId) return safeUser(row);
  return reducedUser(row, primaryOwnerId);
}

/** `GET /api/users?role&active&q` (user.view; reduced projection and staff only for non-admins). */
export async function listUsers(db: DbLike, ctx: AuthContext, input: unknown = {}): Promise<(UserProfile | ReducedUser)[]> {
  assertCan(ctx, "user.view");
  const admin = isAdmin(ctx);
  const f = admin ? parseInput(UserListFiltersSchema, input ?? {}) : parseInput(StaffUserListFiltersSchema, input ?? {});
  const parts: (SQL | undefined)[] = [eq(users.organisationId, ctx.organisationId)];
  if (!admin) parts.push(inArray(users.role, [...STAFF_ROLES]));
  if (f.role) parts.push(eq(users.role, f.role));
  if (f.active === "1" || f.active === "true") parts.push(eq(users.isActive, true));
  if (f.active === "0" || f.active === "false") parts.push(eq(users.isActive, false));
  // Email match: admins only (§2.1 pinned port).
  if (f.q) parts.push(admin ? or(likeSql(users.name, f.q), likeSql(users.email, f.q)) : likeSql(users.name, f.q));
  const rows = await db
    .select()
    .from(users)
    .where(and(...parts))
    .orderBy(binaryAsc(users.name), asc(users.id));
  const primary = await primaryOwnerIdOf(db, ctx);
  return rows.map((u) => projectUser(u, ctx, primary));
}

/** Which directory statistics a viewer may see for `role` (§10.2). */
export interface DirectoryStatsAccess {
  /** active / due today / overdue counts. */
  counts: boolean;
  /** completed this month + revision rate. */
  analytics: boolean;
}

export function directoryStatsAccess(ctx: AuthContext, role: "photographer" | "editor"): DirectoryStatsAccess {
  if (isAdmin(ctx)) return { counts: true, analytics: true };
  const analytics = can(ctx, "analytics.view");
  if (role === "editor") return { counts: can(ctx, "workloads.view_team") || analytics, analytics };
  // Photographer peers: every statistic needs analytics.
  return { counts: analytics, analytics };
}

/**
 * `/team/photographers` / `/team/editors` directory (team.view_members:
 * admins and team members). Inactive people are listed for admins only.
 */
export async function getDirectory(db: DbLike, ctx: AuthContext, role: "photographer" | "editor"): Promise<DirectoryEntry[]> {
  assertCan(ctx, "team.view_members");
  const admin = isAdmin(ctx);
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.organisationId, ctx.organisationId), eq(users.role, role), admin ? undefined : eq(users.isActive, true)))
    .orderBy(binaryAsc(users.name), asc(users.id));
  const access = directoryStatsAccess(ctx, role);
  const statIds = access.counts ? rows.map((r) => r.id) : rows.filter((r) => r.id === ctx.userId).map((r) => r.id);
  const statsFor = await directoryStats(db, ctx, role, statIds);
  const teams = await teamsByUser(
    db,
    ctx,
    rows.map((r) => r.id),
  );
  const primary = await primaryOwnerIdOf(db, ctx);
  return rows.map((u) => {
    const self = u.id === ctx.userId;
    const stats = statsFor.get(u.id) ?? null;
    const showAnalytics = access.analytics || self;
    return {
      user: { ...userRef(u), isAdmin: u.isAdmin, isPrimaryOwner: u.id === primary, title: u.title },
      email: admin || self ? u.email : null,
      title: u.title,
      teams: teams.get(u.id) ?? [],
      stats: stats && !showAnalytics ? { ...stats, completedThisMonth: null, revisionRate: null } : stats,
    };
  });
}

/**
 * Aggregate stats per person (by editor_id for editors, photographer_id for
 * photographers). For editors active / dueToday / overdue are the
 * WorkloadRow numbers (held = WORKLOAD categories, `computeWorkloads`), so
 * `/team/editors`, `/team/workloads`, `/api/workloads` and `/team/users/[id]`
 * all show one "Active" figure. Photographers keep the ACTIVE job counts.
 * No permission check: callers decide which ids and fields to show (§10.2).
 */
export async function directoryStats(
  db: DbLike,
  ctx: AuthContext,
  role: "photographer" | "editor",
  userIds: readonly string[],
): Promise<Map<string, DirectoryStats>> {
  const out = new Map<string, DirectoryStats>();
  if (userIds.length === 0) return out;
  const now = ctx.now();
  const key = role === "editor" ? "editorId" : "photographerId";
  const column = role === "editor" ? jobs.editorId : jobs.photographerId;
  const counts = await jobCountsBy(db, ctx, key, { scope: "org", now, where: inArray(column, [...userIds]) });
  const workloads = role === "editor" ? new Map((await computeWorkloads(db, ctx, { now, editorIds: userIds })).rows.map((r) => [r.editor.id, r])) : null;
  const approved = await approvedJobsInRange(db, ctx, lastDaysRange(ctx, now, 30), { scope: "org", where: role === "photographer" ? isNotNull(jobs.photographerId) : undefined });
  const approvedBy = groupBy(approved, (j) => (role === "editor" ? j.approvingEditorId : j.photographerId));
  for (const id of userIds) {
    const c = counts.get(id);
    const w = workloads?.get(id);
    out.set(id, {
      active: workloads ? (w?.active ?? 0) : (c?.open ?? 0),
      dueToday: workloads ? (w?.dueToday ?? 0) : (c?.dueToday ?? 0),
      overdue: workloads ? (w?.overdue ?? 0) : (c?.overdue ?? 0),
      completedThisMonth: workloads ? (w?.completedThisMonth ?? 0) : (c?.completedThisMonth ?? 0),
      revisionRate: revisionRate(approvedBy.get(id) ?? []).rate,
    });
  }
  return out;
}

/**
 * `GET /api/users/:id` → UserDetailView. Foreign ids → 404; a client user's
 * id → 404 for non-admins (§3.4). Admins and the user themself get the
 * profile; the workload detail follows the person-page rule (§3.4: admin,
 * self, ⚑workloads members for editors, ⚑analytics members for anyone).
 */
export async function getUserDetail(db: DbLike, ctx: AuthContext, userId: string): Promise<UserDetailView> {
  assertCan(ctx, "user.view");
  const target = await loadUserInOrg(db, ctx, userId);
  const admin = isAdmin(ctx);
  if (!admin && !can(ctx, "user.view", { id: target.id, role: target.role, isActive: target.isActive, organisationId: target.organisationId })) {
    throw new NotFoundError("User");
  }
  const self = target.id === ctx.userId;
  const full = admin || self;
  const primary = await primaryOwnerIdOf(db, ctx);
  const isStaffTarget = target.role !== "client";
  const settings = full ? await loadOrgSettings(db, ctx) : null;
  /** Admin controls (role, capacity, deactivate…) for another person this viewer may administer. */
  const canManage =
    admin &&
    !self &&
    can(ctx, "user.edit", {
      id: target.id,
      role: target.role,
      isActive: target.isActive,
      organisationId: target.organisationId,
      isAdmin: target.isAdmin,
      isPrimaryOwner: target.id === primary,
    });
  const workloadAllowed = isStaffTarget && canOpenPersonPage(ctx, target, "workload");
  return {
    ref: { ...userRef(target), isAdmin: target.isAdmin, isPrimaryOwner: target.id === primary, title: target.title },
    profile: full ? safeUser(target) : null,
    teams: (await teamsByUser(db, ctx, [target.id])).get(target.id) ?? [],
    capacityHoursPerWeek: settings ? (target.capacityHoursPerWeek ?? settings.defaultCapacityHoursPerWeek) : null,
    openJobCount: full || workloadAllowed ? await openJobCountFor(db, ctx, target.id) : null,
    workload: workloadAllowed ? await getWorkloadDetail(db, ctx, target.id) : null,
    canManage,
  };
}
