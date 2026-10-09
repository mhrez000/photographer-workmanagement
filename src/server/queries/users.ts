/**
 * People directories and user detail (ARCHITECTURE.md §3.2 user.view,
 * §10 `/team/photographers`, `/team/editors`, `/team/users/[id]`,
 * `/settings/users`).
 *
 * Projection: owners/managers (and the user themself) get the full safe row
 * (`UserProfile`, never the hash or session version); photographers and
 * editors get the reduced projection `id, name, role, avatarColour,
 * isActive` only. Directory stats are aggregates and require
 * workloads.view_team (except on the viewer's own row).
 */
import { and, asc, eq, inArray, isNotNull, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "@/db/index";
import { jobs, users } from "@/db/schema";
import { ROLES } from "@/lib/constants";
import { revisionRate } from "@/lib/metrics";
import type { AuthContext, DirectoryEntry, DirectoryStats, User, UserDetailView, UserProfile, UserRef } from "@/lib/types";
import { assertCan, can, isManagement } from "@/server/auth/permissions";
import { loadUserInOrg, parseInput, safeUser, userRef } from "@/server/services/_shared";
import { approvedJobsInRange, groupBy, jobCountsBy, lastDaysRange, loadOrgSettings } from "./metrics";
import { likeSql } from "./scope";
import { teamsByUser } from "./teams";
import { canViewTeamWorkloads, computeWorkloads, getWorkloadDetail, openJobCountFor } from "./workloads";

const one = <T extends z.ZodType>(item: T) => z.preprocess((v) => (Array.isArray(v) ? v[0] : v === "" ? undefined : v), item);

export const UserListFiltersSchema = z.object({
  role: one(z.enum(ROLES).optional()),
  /** "1" active only, "0" inactive only, absent = both. */
  active: one(z.enum(["1", "0", "true", "false"]).optional()),
  q: one(z.string().trim().min(1).max(200).optional()),
});

/** Full safe row for management / self, reduced UserRef otherwise. */
export function projectUser(row: User, ctx: AuthContext): UserProfile | UserRef {
  if (isManagement(ctx) || row.id === ctx.userId) return safeUser(row);
  return userRef(row);
}

/** `GET /api/users?role&active&q` (user.view; reduced projection for P/E). */
export function listUsers(db: DbLike, ctx: AuthContext, input: unknown = {}): (UserProfile | UserRef)[] {
  assertCan(ctx, "user.view");
  const f = parseInput(UserListFiltersSchema, input ?? {});
  const parts: (SQL | undefined)[] = [eq(users.organisationId, ctx.organisationId)];
  if (f.role) parts.push(eq(users.role, f.role));
  if (f.active === "1" || f.active === "true") parts.push(eq(users.isActive, true));
  if (f.active === "0" || f.active === "false") parts.push(eq(users.isActive, false));
  if (f.q) parts.push(isManagement(ctx) ? or(likeSql(users.name, f.q), likeSql(users.email, f.q)) : likeSql(users.name, f.q));
  return db
    .select()
    .from(users)
    .where(and(...parts))
    .orderBy(asc(users.name), asc(users.id))
    .all()
    .map((u) => projectUser(u, ctx));
}

/**
 * `/team/photographers` / `/team/editors` directory (team.view_members).
 * Inactive people are listed for management only.
 */
export function getDirectory(db: DbLike, ctx: AuthContext, role: "photographer" | "editor"): DirectoryEntry[] {
  assertCan(ctx, "team.view_members");
  const management = isManagement(ctx);
  const rows = db
    .select()
    .from(users)
    .where(and(eq(users.organisationId, ctx.organisationId), eq(users.role, role), management ? undefined : eq(users.isActive, true)))
    .orderBy(asc(users.name))
    .all();
  const seeStats = canViewTeamWorkloads(ctx);
  const statsFor = directoryStats(
    db,
    ctx,
    role,
    seeStats ? rows.map((r) => r.id) : rows.filter((r) => r.id === ctx.userId).map((r) => r.id),
  );
  const teams = teamsByUser(
    db,
    ctx,
    rows.map((r) => r.id),
  );
  return rows.map((u) => {
    const full = management || u.id === ctx.userId;
    return {
      user: userRef(u),
      email: full ? u.email : null,
      title: full ? u.title : null,
      teams: teams.get(u.id) ?? [],
      stats: statsFor.get(u.id) ?? null,
    };
  });
}

/**
 * Aggregate stats per person (by editor_id for editors, photographer_id for
 * photographers). For editors active / dueToday / overdue are the
 * WorkloadRow numbers (held = WORKLOAD categories, `computeWorkloads`), so
 * `/team/editors`, `/team/workloads`, `/api/workloads` and `/team/users/[id]`
 * all show one "Active" figure. Photographers keep the ACTIVE job counts.
 */
export function directoryStats(db: DbLike, ctx: AuthContext, role: "photographer" | "editor", userIds: readonly string[]): Map<string, DirectoryStats> {
  const out = new Map<string, DirectoryStats>();
  if (userIds.length === 0) return out;
  const now = ctx.now();
  const key = role === "editor" ? "editorId" : "photographerId";
  const column = role === "editor" ? jobs.editorId : jobs.photographerId;
  const counts = jobCountsBy(db, ctx, key, { scope: "org", now, where: inArray(column, [...userIds]) });
  const workloads = role === "editor" ? new Map(computeWorkloads(db, ctx, { now, editorIds: userIds }).rows.map((r) => [r.editor.id, r])) : null;
  const approved = approvedJobsInRange(db, ctx, lastDaysRange(ctx, now, 30), { scope: "org", where: role === "photographer" ? isNotNull(jobs.photographerId) : undefined });
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
 * `GET /api/users/:id` → UserDetailView. Foreign ids → 404. Management and
 * the user themself get the profile and WorkloadDetail; others the reduced ref.
 */
export function getUserDetail(db: DbLike, ctx: AuthContext, userId: string): UserDetailView {
  assertCan(ctx, "user.view");
  const target = loadUserInOrg(db, ctx, userId);
  const full = isManagement(ctx) || target.id === ctx.userId;
  const settings = full ? loadOrgSettings(db, ctx) : null;
  /** Management controls (role, capacity, deactivate…) for another person this viewer may administer. */
  const canManage =
    isManagement(ctx) &&
    target.id !== ctx.userId &&
    can(ctx, "user.edit", { id: target.id, role: target.role, isActive: target.isActive, organisationId: target.organisationId });
  return {
    ref: userRef(target),
    profile: full ? safeUser(target) : null,
    teams: teamsByUser(db, ctx, [target.id]).get(target.id) ?? [],
    capacityHoursPerWeek: settings ? (target.capacityHoursPerWeek ?? settings.defaultCapacityHoursPerWeek) : null,
    openJobCount: full ? openJobCountFor(db, ctx, target.id) : null,
    workload: full && target.role !== "owner" && target.role !== "manager" ? getWorkloadDetail(db, ctx, target.id) : null,
    canManage,
  };
}
