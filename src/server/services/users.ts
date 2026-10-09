/**
 * Users service (ARCHITECTURE.md §2.1, §3.2, §4.5 "User deactivation", §5 user.*).
 *
 * Every mutation: permission check → Zod parse → writes (one tx) → recordEvent.
 * Passwords: bcrypt is slow, so the temp password + hash can be prepared
 * outside the transaction (`prepareTempPassword`) and passed in as `secret`;
 * when omitted the services hash synchronously (cost BCRYPT_COST). The
 * plaintext temp password is returned once and never stored or audited.
 *
 * Guards:
 * - managers act on photographers/editors only; role changes only P ⇄ E
 * - nobody deactivates themself; the last active owner can never be demoted
 *   or deactivated
 * - a role change that would leave the user holding incompatible open
 *   assignments (editor jobs for a non-editor, photographer jobs for an
 *   editor) is rejected — reassign first
 * - deactivate/role change/password reset bump `session_version` (immediate
 *   revocation of every cookie)
 */
import { hashSync } from "bcryptjs";
import { and, count, eq, inArray, or } from "drizzle-orm";
import { jobs, userNotificationPrefs, users } from "@/db/schema";
import {
  AVATAR_PALETTE,
  BCRYPT_COST,
  CATEGORY_GROUPS,
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_META,
  type NotificationType,
  type Role,
} from "@/lib/constants";
import { newId } from "@/lib/ids";
import type { AuthContext, User } from "@/lib/types";
import {
  ChangeRoleInput,
  DeactivateUserInput,
  InviteUserInput,
  SetCapacityInput,
  SetNotificationPrefsInput,
  SetVisibilityFlagsInput,
  UpdateUserInput,
  UserIdInput,
} from "@/lib/validation/users";
import { recordEvent } from "@/server/audit";
import { generateTempPassword, hashPassword } from "@/server/auth/password";
import { assertCan, isManagement, type UserPermissionRef } from "@/server/auth/permissions";
import { ForbiddenError, UnauthorizedError } from "@/server/errors";
import { loadUserInOrg, parseInput, safeUser, withTx, type Db, type DbLike, type SafeUser, type Tx } from "./_shared";
import { checkVersion, diffFields, ruleViolation } from "./_admin";
import { assertRoleMayEver } from "./clients";
import { assignEditor, unassignEditor } from "./assignments";
import { closeRunningSessionForUser } from "./timeTracking";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

export const ANONYMISED_NAME = "Former team member";
export const ANONYMISED_AVATAR = "#94a3b8";

export interface PreparedSecret {
  tempPassword: string;
  passwordHash: string;
}

/** Generates a temp password and hashes it (async; call before opening the transaction). */
export async function prepareTempPassword(cost: number = BCRYPT_COST): Promise<PreparedSecret> {
  const tempPassword = generateTempPassword();
  return { tempPassword, passwordHash: await hashPassword(tempPassword, cost) };
}

function secretOrSync(secret: PreparedSecret | undefined): PreparedSecret {
  if (secret) return secret;
  const tempPassword = generateTempPassword();
  return { tempPassword, passwordHash: hashSync(tempPassword, BCRYPT_COST) };
}

export function userPermissionRef(row: User, nextRole?: Role): UserPermissionRef {
  return { id: row.id, role: row.role, isActive: row.isActive, organisationId: row.organisationId, ...(nextRole ? { nextRole } : {}) };
}

function requireHuman(ctx: AuthContext, action: Parameters<typeof assertRoleMayEver>[1]): string {
  if (!ctx.userId || ctx.isSystem) throw new ForbiddenError(action);
  return ctx.userId;
}

export function activeOwnerCount(db: DbLike, organisationId: string): number {
  const row = db
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.organisationId, organisationId), eq(users.role, "owner"), eq(users.isActive, true)))
    .get();
  return row?.n ?? 0;
}

function isEmailTaken(db: DbLike, email: string, exceptUserId?: string): boolean {
  const row = db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
  return !!row && row.id !== exceptUserId;
}

export interface OpenJobRef {
  jobId: string;
  jobNumber: string;
  role: "editor" | "photographer";
  version: number;
}

/** Active (non-terminal) jobs where the user is the current editor or photographer. */
export function openJobsForUser(db: DbLike, ctx: AuthContext, userId: string): OpenJobRef[] {
  const rows = db
    .select({ id: jobs.id, jobNumber: jobs.jobNumber, editorId: jobs.editorId, photographerId: jobs.photographerId, version: jobs.version })
    .from(jobs)
    .where(
      and(
        eq(jobs.organisationId, ctx.organisationId),
        inArray(jobs.statusCategory, [...CATEGORY_GROUPS.ACTIVE]),
        or(eq(jobs.editorId, userId), eq(jobs.photographerId, userId)),
      ),
    )
    .orderBy(jobs.jobNumber)
    .all();
  const out: OpenJobRef[] = [];
  for (const r of rows) {
    if (r.editorId === userId) out.push({ jobId: r.id, jobNumber: r.jobNumber, role: "editor", version: r.version });
    if (r.photographerId === userId) out.push({ jobId: r.id, jobNumber: r.jobNumber, role: "photographer", version: r.version });
  }
  return out;
}

function assertNotAnonymised(user: User): void {
  if (user.anonymisedAt) throw ruleViolation("This user has been anonymised and can no longer be changed");
}

/** Rejects demoting/deactivating the last active owner. */
function assertNotLastOwner(db: DbLike, target: User, what: string): void {
  if (target.role === "owner" && target.isActive && activeOwnerCount(db, target.organisationId) <= 1) {
    throw ruleViolation(`You cannot ${what} the last active owner. Make someone else an owner first.`);
  }
}

/* ------------------------------------------------------------------ */
/*  Invite                                                             */
/* ------------------------------------------------------------------ */

export interface InviteResult {
  user: SafeUser;
  /** Shown once to the inviter; never stored in plaintext or audited. */
  tempPassword: string;
}

export function inviteUser(tx: Tx, ctx: AuthContext, input: unknown, secret?: PreparedSecret): InviteResult {
  assertCan(ctx, "user.invite");
  requireHuman(ctx, "user.invite");
  const data = parseInput(InviteUserInput, input);
  assertCan(ctx, "user.invite", { id: "new", role: data.role, isActive: true, organisationId: ctx.organisationId, nextRole: data.role });
  if (isEmailTaken(tx, data.email)) throw ruleViolation("This email address is already registered", {}, "email");

  const { tempPassword, passwordHash } = secretOrSync(secret);
  const now = ctx.now();
  const palette = AVATAR_PALETTE;
  const row = tx
    .insert(users)
    .values({
      organisationId: ctx.organisationId,
      email: data.email,
      passwordHash,
      name: data.name,
      role: data.role,
      title: data.title ?? null,
      avatarColour: data.avatarColour ?? palette[Math.floor(Date.parse(now) / 1000) % palette.length],
      capacityHoursPerWeek: data.capacityHoursPerWeek ?? null,
      canViewTeamWorkloads: data.canViewTeamWorkloads ?? false,
      canViewAnalytics: data.canViewAnalytics ?? false,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  recordEvent(tx, ctx, {
    entityType: "user",
    entityId: row.id,
    eventType: "user.created",
    action: "created",
    previousValue: null,
    newValue: {
      name: row.name,
      email: row.email,
      role: row.role,
      title: row.title,
      capacityHoursPerWeek: row.capacityHoursPerWeek,
      canViewTeamWorkloads: row.canViewTeamWorkloads,
      canViewAnalytics: row.canViewAnalytics,
    },
    metadata: { targetUserId: row.id },
  });
  return { user: safeUser(row), tempPassword };
}

/** Async convenience: hashes outside the transaction, then runs `inviteUser`. */
export async function inviteUserWithTempPassword(ctx: AuthContext, input: unknown, db?: Db): Promise<InviteResult> {
  assertCan(ctx, "user.invite");
  const secret = await prepareTempPassword();
  return withTx((tx) => inviteUser(tx, ctx, input, secret), { db });
}

/* ------------------------------------------------------------------ */
/*  Profile                                                            */
/* ------------------------------------------------------------------ */

const SELF_FIELDS = ["name", "title", "avatarColour"] as const;
const PROFILE_FIELDS = ["name", "title", "avatarColour", "email"] as const;

/**
 * Self edits (any active user): name, title, avatar colour.
 * Everything else — and any edit of another user — needs `user.edit`
 * (owner any; manager photographers/editors).
 */
export function updateUser(tx: Tx, ctx: AuthContext, input: unknown): SafeUser {
  const actorId = requireHuman(ctx, "user.edit");
  const data = parseInput(UpdateUserInput, input);
  const target = loadUserInOrg(tx, ctx, data.userId);
  const selfOnly = target.id === actorId && data.email === undefined;
  if (!selfOnly) assertCan(ctx, "user.edit", userPermissionRef(target));
  // Photographers/editors edit only their own name/title/avatar (§3.2 "self (name, avatar)").
  if (data.email !== undefined && !isManagement(ctx)) throw new ForbiddenError("user.edit", "Only an owner or manager can change an email address");
  assertNotAnonymised(target);
  checkVersion(target, data.expectedVersion, safeUser(target));

  const diff = diffFields(target, data, selfOnly ? SELF_FIELDS : PROFILE_FIELDS);
  if (diff.changed.length === 0) return safeUser(target);
  if (diff.set.email && isEmailTaken(tx, diff.set.email, target.id)) {
    throw ruleViolation("This email address is already registered", {}, "email");
  }
  const row = tx
    .update(users)
    .set({ ...diff.set, updatedAt: ctx.now(), version: target.version + 1 })
    .where(eq(users.id, target.id))
    .returning()
    .get();
  recordEvent(tx, ctx, {
    entityType: "user",
    entityId: target.id,
    eventType: "user.updated",
    action: "updated",
    previousValue: diff.previous,
    newValue: diff.next,
    metadata: { targetUserId: target.id, targetName: row.name, self: target.id === actorId },
  });
  return safeUser(row);
}

/* ------------------------------------------------------------------ */
/*  Role                                                               */
/* ------------------------------------------------------------------ */

export function changeRole(tx: Tx, ctx: AuthContext, input: unknown): SafeUser {
  assertRoleMayEver(ctx, "user.change_role");
  requireHuman(ctx, "user.change_role");
  const data = parseInput(ChangeRoleInput, input);
  const target = loadUserInOrg(tx, ctx, data.userId);
  assertCan(ctx, "user.change_role", userPermissionRef(target, data.role));
  assertNotAnonymised(target);
  checkVersion(target, data.expectedVersion, safeUser(target));
  if (target.role === data.role) return safeUser(target);
  if (data.role !== "owner") assertNotLastOwner(tx, target, "demote");

  const open = openJobsForUser(tx, ctx, target.id);
  const editorJobs = open.filter((j) => j.role === "editor");
  const photographerJobs = open.filter((j) => j.role === "photographer");
  if (data.role !== "editor" && editorJobs.length > 0) {
    throw ruleViolation(`Reassign ${target.name}'s ${editorJobs.length} open editing job(s) before changing their role`, {
      openJobs: editorJobs.map((j) => ({ jobId: j.jobId, jobNumber: j.jobNumber })),
    });
  }
  if (data.role === "editor" && photographerJobs.length > 0) {
    throw ruleViolation(`${target.name} is the photographer on ${photographerJobs.length} open job(s); reassign them first`, {
      openJobs: photographerJobs.map((j) => ({ jobId: j.jobId, jobNumber: j.jobNumber })),
    });
  }

  const row = tx
    .update(users)
    .set({ role: data.role, sessionVersion: target.sessionVersion + 1, updatedAt: ctx.now(), version: target.version + 1 })
    .where(eq(users.id, target.id))
    .returning()
    .get();
  recordEvent(tx, ctx, {
    entityType: "user",
    entityId: target.id,
    eventType: "user.role_changed",
    action: "updated",
    previousValue: { role: target.role, name: target.name },
    newValue: { role: row.role, name: row.name },
    metadata: { targetUserId: target.id },
  });
  return safeUser(row);
}

/* ------------------------------------------------------------------ */
/*  Deactivate / reactivate                                            */
/* ------------------------------------------------------------------ */

export type OpenJobAction = "reassigned" | "unassigned" | "kept";

export interface DeactivateResult {
  user: SafeUser;
  openJobs: { jobId: string; jobNumber: string; role: "editor" | "photographer"; action: OpenJobAction }[];
}

/**
 * Deactivates a user (§4.5): closes their running timer (`auto_deactivated`),
 * sets `is_active = false`, bumps `session_version`, then for every open
 * EDITOR job either reassigns it to `reassignTo` (via `assignEditor`),
 * unassigns it (`unassign: true`, via `unassignEditor` → back to Ready) or
 * keeps it (it then shows as an editor_unavailable bottleneck). Photographer
 * jobs are kept. Event `user.deactivated` with the `openJobs` list.
 */
export function deactivateUser(tx: Tx, ctx: AuthContext, input: unknown): DeactivateResult {
  assertRoleMayEver(ctx, "user.deactivate");
  const actorId = requireHuman(ctx, "user.deactivate");
  const data = parseInput(DeactivateUserInput, input);
  const target = loadUserInOrg(tx, ctx, data.userId);
  assertCan(ctx, "user.deactivate", userPermissionRef(target));
  checkVersion(target, data.expectedVersion, safeUser(target));
  if (!target.isActive) throw ruleViolation(`${target.name} is already deactivated`);
  assertNotLastOwner(tx, target, "deactivate");

  let reassignTo: User | null = null;
  if (data.reassignTo) {
    reassignTo = loadUserInOrg(tx, ctx, data.reassignTo);
    if (reassignTo.id === target.id) throw ruleViolation("Choose a different editor to take over", {}, "reassignTo");
    if (!reassignTo.isActive || reassignTo.role !== "editor") {
      throw ruleViolation("Jobs can only be reassigned to an active editor", {}, "reassignTo");
    }
  }

  const now = ctx.now();
  // 1. Stop the running timer first so it ends with the deactivation reason.
  closeRunningSessionForUser(tx, ctx, { userId: target.id, reason: "auto_deactivated" });

  // 2. Revoke access immediately.
  const row = tx
    .update(users)
    .set({
      isActive: false,
      deactivatedAt: now,
      deactivatedByUserId: actorId,
      sessionVersion: target.sessionVersion + 1,
      updatedAt: now,
      version: target.version + 1,
    })
    .where(eq(users.id, target.id))
    .returning()
    .get();

  // 3. Hand over open editor jobs.
  const openJobs: DeactivateResult["openJobs"] = [];
  for (const job of openJobsForUser(tx, ctx, target.id)) {
    let action: OpenJobAction = "kept";
    if (job.role === "editor" && reassignTo) {
      assignEditor(tx, ctx, { jobId: job.jobId, userId: reassignTo.id, reason: "user_deactivated", unassignReason: "user_deactivated" });
      action = "reassigned";
    } else if (job.role === "editor" && data.unassign) {
      unassignEditor(tx, ctx, { jobId: job.jobId, userId: null, reason: "user_deactivated", unassignReason: "user_deactivated" });
      action = "unassigned";
    }
    openJobs.push({ jobId: job.jobId, jobNumber: job.jobNumber, role: job.role, action });
  }

  recordEvent(tx, ctx, {
    entityType: "user",
    entityId: target.id,
    eventType: "user.deactivated",
    action: "deactivated",
    previousValue: { isActive: true, name: target.name },
    newValue: { isActive: false, name: target.name, deactivatedAt: now },
    metadata: {
      targetUserId: target.id,
      openJobs: openJobs.map((j) => ({ jobId: j.jobId, jobNumber: j.jobNumber, role: j.role, action: j.action })),
      reassignTo: reassignTo?.id ?? null,
      reassignToName: reassignTo?.name ?? null,
      reason: data.reason ?? null,
    },
  });
  return { user: safeUser(row), openJobs };
}

export function reactivateUser(tx: Tx, ctx: AuthContext, input: unknown): SafeUser {
  assertRoleMayEver(ctx, "user.reactivate");
  requireHuman(ctx, "user.reactivate");
  const data = parseInput(UserIdInput, input);
  const target = loadUserInOrg(tx, ctx, data.userId);
  assertCan(ctx, "user.reactivate", userPermissionRef(target));
  assertNotAnonymised(target);
  checkVersion(target, data.expectedVersion, safeUser(target));
  if (target.isActive) throw ruleViolation(`${target.name} is already active`);
  const row = tx
    .update(users)
    .set({ isActive: true, deactivatedAt: null, deactivatedByUserId: null, updatedAt: ctx.now(), version: target.version + 1 })
    .where(eq(users.id, target.id))
    .returning()
    .get();
  recordEvent(tx, ctx, {
    entityType: "user",
    entityId: target.id,
    eventType: "user.reactivated",
    action: "reactivated",
    previousValue: { isActive: false, name: target.name, deactivatedAt: target.deactivatedAt },
    newValue: { isActive: true, name: target.name },
    metadata: { targetUserId: target.id },
  });
  return safeUser(row);
}

/* ------------------------------------------------------------------ */
/*  Passwords                                                          */
/* ------------------------------------------------------------------ */

export interface ResetPasswordResult {
  userId: string;
  /** Shown once; the user's sessions are revoked. */
  tempPassword: string;
}

/**
 * Admin reset (owner any; manager photographers/editors; P/E self): sets a
 * fresh temp password and bumps `session_version`. Changing your own
 * password with the current one is `changePassword` in services/auth.ts.
 */
export function resetPassword(tx: Tx, ctx: AuthContext, input: unknown, secret?: PreparedSecret): ResetPasswordResult {
  assertRoleMayEver(ctx, "user.reset_password");
  const actorId = requireHuman(ctx, "user.reset_password");
  const data = parseInput(UserIdInput, input);
  const target = loadUserInOrg(tx, ctx, data.userId);
  assertCan(ctx, "user.reset_password", userPermissionRef(target));
  assertNotAnonymised(target);
  checkVersion(target, data.expectedVersion, safeUser(target));
  const { tempPassword, passwordHash } = secretOrSync(secret);
  const nextSession = target.sessionVersion + 1;
  tx.update(users)
    .set({ passwordHash, sessionVersion: nextSession, updatedAt: ctx.now(), version: target.version + 1 })
    .where(eq(users.id, target.id))
    .run();
  recordEvent(tx, ctx, {
    entityType: "user",
    entityId: target.id,
    eventType: "user.password_changed",
    action: "updated",
    previousValue: { sessionVersion: target.sessionVersion },
    newValue: { sessionVersion: nextSession, name: target.name },
    metadata: { targetUserId: target.id, self: target.id === actorId, reset: true },
  });
  return { userId: target.id, tempPassword };
}

/** Async convenience: hashes outside the transaction, then runs `resetPassword`. */
export async function resetPasswordWithTempPassword(ctx: AuthContext, input: unknown, db?: Db): Promise<ResetPasswordResult> {
  assertRoleMayEver(ctx, "user.reset_password");
  const secret = await prepareTempPassword();
  return withTx((tx) => resetPassword(tx, ctx, input, secret), { db });
}

/* ------------------------------------------------------------------ */
/*  Capacity / visibility flags                                        */
/* ------------------------------------------------------------------ */

export function setCapacity(tx: Tx, ctx: AuthContext, input: unknown): SafeUser {
  assertRoleMayEver(ctx, "user.set_capacity");
  requireHuman(ctx, "user.set_capacity");
  const data = parseInput(SetCapacityInput, input);
  const target = loadUserInOrg(tx, ctx, data.userId);
  assertCan(ctx, "user.set_capacity", userPermissionRef(target));
  assertNotAnonymised(target);
  checkVersion(target, data.expectedVersion, safeUser(target));
  if (target.capacityHoursPerWeek === data.capacityHoursPerWeek) return safeUser(target);
  const row = tx
    .update(users)
    .set({ capacityHoursPerWeek: data.capacityHoursPerWeek, updatedAt: ctx.now(), version: target.version + 1 })
    .where(eq(users.id, target.id))
    .returning()
    .get();
  recordEvent(tx, ctx, {
    entityType: "user",
    entityId: target.id,
    eventType: "user.capacity_changed",
    action: "updated",
    previousValue: { capacityHoursPerWeek: target.capacityHoursPerWeek, name: target.name },
    newValue: { capacityHoursPerWeek: row.capacityHoursPerWeek, name: row.name },
    metadata: { targetUserId: target.id },
  });
  return safeUser(row);
}

const FLAG_FIELDS = ["canViewTeamWorkloads", "canViewAnalytics"] as const;

export function setVisibilityFlags(tx: Tx, ctx: AuthContext, input: unknown): SafeUser {
  assertRoleMayEver(ctx, "user.set_visibility_flags");
  requireHuman(ctx, "user.set_visibility_flags");
  const data = parseInput(SetVisibilityFlagsInput, input);
  const target = loadUserInOrg(tx, ctx, data.userId);
  assertCan(ctx, "user.set_visibility_flags", userPermissionRef(target));
  assertNotAnonymised(target);
  checkVersion(target, data.expectedVersion, safeUser(target));
  const diff = diffFields(target, data, FLAG_FIELDS);
  if (diff.changed.length === 0) return safeUser(target);
  const row = tx
    .update(users)
    .set({ ...diff.set, updatedAt: ctx.now(), version: target.version + 1 })
    .where(eq(users.id, target.id))
    .returning()
    .get();
  recordEvent(tx, ctx, {
    entityType: "user",
    entityId: target.id,
    eventType: "user.flags_changed",
    action: "updated",
    previousValue: diff.previous,
    newValue: diff.next,
    metadata: { targetUserId: target.id, targetName: target.name },
  });
  return safeUser(row);
}

/* ------------------------------------------------------------------ */
/*  Anonymise                                                          */
/* ------------------------------------------------------------------ */

/**
 * Owner-only, target must already be deactivated (§5 Anonymisation):
 * rewrites PII on the users row only. Comments and events stay; names are
 * joined at read time, so feeds show "Former team member".
 */
export function anonymiseUser(tx: Tx, ctx: AuthContext, input: unknown): SafeUser {
  assertRoleMayEver(ctx, "user.anonymise");
  requireHuman(ctx, "user.anonymise");
  const data = parseInput(UserIdInput, input);
  const target = loadUserInOrg(tx, ctx, data.userId);
  if (target.isActive) throw ruleViolation("Deactivate this user before anonymising them");
  assertCan(ctx, "user.anonymise", userPermissionRef(target));
  checkVersion(target, data.expectedVersion, safeUser(target));
  if (target.anonymisedAt) throw ruleViolation("This user is already anonymised");
  const now = ctx.now();
  const row = tx
    .update(users)
    .set({
      name: ANONYMISED_NAME,
      email: `anon-${target.id}@invalid`,
      // Not a bcrypt hash: verifyPassword() returns false for it, so nobody can log in.
      passwordHash: `!anonymised!${newId()}${newId()}`,
      avatarColour: ANONYMISED_AVATAR,
      title: null,
      anonymisedAt: now,
      sessionVersion: target.sessionVersion + 1,
      updatedAt: now,
      version: target.version + 1,
    })
    .where(eq(users.id, target.id))
    .returning()
    .get();
  recordEvent(tx, ctx, {
    entityType: "user",
    entityId: target.id,
    eventType: "user.anonymised",
    action: "anonymised",
    previousValue: { anonymisedAt: null },
    newValue: { anonymisedAt: now, name: ANONYMISED_NAME },
    metadata: { targetUserId: target.id },
  });
  return safeUser(row);
}

/* ------------------------------------------------------------------ */
/*  Notification preferences                                           */
/* ------------------------------------------------------------------ */

export interface NotificationPrefView {
  type: NotificationType;
  label: string;
  mandatory: boolean;
  enabled: boolean;
}

/** Own preferences (missing row = enabled; mandatory types always on). */
export function getNotificationPrefs(db: DbLike, ctx: AuthContext, userId?: string): NotificationPrefView[] {
  const target = userId ?? ctx.userId;
  if (!target) throw new UnauthorizedError();
  assertCan(ctx, "notification.prefs", { userId: target, organisationId: ctx.organisationId });
  loadUserInOrg(db, ctx, target);
  const rows = db.select().from(userNotificationPrefs).where(eq(userNotificationPrefs.userId, target)).all();
  const byType = new Map(rows.map((r) => [r.type, r.enabled]));
  return NOTIFICATION_TYPES.map((type) => {
    const mandatory = NOTIFICATION_TYPE_META[type].mandatory;
    return { type, label: NOTIFICATION_TYPE_META[type].label, mandatory, enabled: mandatory ? true : (byType.get(type) ?? true) };
  });
}

export function setNotificationPrefs(tx: Tx, ctx: AuthContext, input: unknown): NotificationPrefView[] {
  const actorId = requireHuman(ctx, "notification.prefs");
  assertCan(ctx, "notification.prefs", { userId: actorId, organisationId: ctx.organisationId });
  const data = parseInput(SetNotificationPrefsInput, input);
  const target = data.userId ?? actorId;
  assertCan(ctx, "notification.prefs", { userId: target, organisationId: ctx.organisationId });

  const current = new Map(getNotificationPrefs(tx, ctx, target).map((p) => [p.type, p.enabled]));
  const previous: Record<string, boolean> = {};
  const next: Record<string, boolean> = {};
  const now = ctx.now();
  for (const type of NOTIFICATION_TYPES) {
    const enabled = data.prefs[type];
    if (enabled === undefined) continue;
    if (NOTIFICATION_TYPE_META[type].mandatory) {
      if (!enabled) throw ruleViolation(`"${NOTIFICATION_TYPE_META[type].label}" notifications cannot be turned off`, {}, `prefs.${type}`);
      continue;
    }
    if (current.get(type) === enabled) continue;
    previous[type] = current.get(type) ?? true;
    next[type] = enabled;
    tx.insert(userNotificationPrefs)
      .values({ organisationId: ctx.organisationId, userId: target, type, enabled, updatedAt: now })
      .onConflictDoUpdate({ target: [userNotificationPrefs.userId, userNotificationPrefs.type], set: { enabled, updatedAt: now } })
      .run();
  }
  if (Object.keys(next).length > 0) {
    recordEvent(tx, ctx, {
      entityType: "user",
      entityId: target,
      eventType: "user.notification_prefs_changed",
      action: "updated",
      previousValue: previous,
      newValue: next,
      metadata: { targetUserId: target },
    });
  }
  return getNotificationPrefs(tx, ctx, target);
}
