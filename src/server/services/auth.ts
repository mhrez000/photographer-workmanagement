/**
 * Authentication service: login, logout, change password (ARCHITECTURE.md §3.3).
 *
 * The DB halves (`authenticate`, `recordLogout`, `changePasswordInDb`) take
 * an explicit `db` and never touch cookies, so tests drive them directly.
 * `login` / `logout` / `changePassword` add the cookie side effects for
 * route handlers and server actions.
 *
 * Audit: `auth.logged_in`, `auth.login_failed` (only when the email matches
 * an account — events need an organisation; never the password),
 * `auth.logged_out`, `user.password_changed`; all management-visibility.
 * `users.last_login_at` is an audit exemption (§5).
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, type Db, type Tx } from "@/db/index";
import { users } from "@/db/schema";
import type { AuthContext, User } from "@/lib/types";
import { ChangePasswordInput, LoginInput } from "@/lib/validation/auth";
import { recordEvent } from "@/server/audit";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "@/server/auth/password";
import {
  checkLoginRateLimit,
  loginRateLimitKey,
  recordLoginFailure,
  resetLoginRateLimit,
} from "@/server/auth/rate-limit";
import { buildContextFromDb, clearSession, createSession, systemContext } from "@/server/auth/session";
import { ConflictError, RateLimitedError, UnauthorizedError, ValidationError } from "@/server/errors";
import { parseInput, withTx } from "./_shared";

const INVALID_CREDENTIALS = "Incorrect email or password";

export interface AuthenticatedUser {
  id: string;
  organisationId: string;
  name: string;
  email: string;
  role: User["role"];
  sessionVersion: number;
}

function auditFailure(db: Db, user: User, input: { email: string; ip?: string | null; userAgent?: string | null }, reason: string): void {
  const ctx = systemContext(user.organisationId, { db, cause: "user" });
  withTx(
    (tx) =>
      recordEvent(tx, ctx, {
        entityType: "auth",
        entityId: user.id,
        eventType: "auth.login_failed",
        action: "login_failed",
        previousValue: null,
        newValue: { email: input.email },
        metadata: { ip: input.ip ?? null, userAgent: input.userAgent ?? null, reason, targetUserId: user.id },
        visibility: "management",
      }),
    { db },
  );
}

/**
 * Verifies credentials (rate-limited per email+IP), records the outcome and
 * returns the user. Throws RateLimitedError (429) or UnauthorizedError (401,
 * one generic message for unknown email / wrong password / inactive account).
 */
export async function authenticate(db: Db, raw: unknown): Promise<AuthenticatedUser> {
  const input = parseInput(LoginInput, raw);
  const key = loginRateLimitKey(input.email, input.ip);
  const limit = checkLoginRateLimit(key);
  if (!limit.allowed) throw new RateLimitedError(limit.retryAfterSeconds);

  const user = db.select().from(users).where(eq(users.email, input.email)).get();
  if (!user) {
    await verifyAgainstDummy(input.password);
    const after = recordLoginFailure(key);
    if (!after.allowed) throw new RateLimitedError(after.retryAfterSeconds);
    throw new UnauthorizedError(INVALID_CREDENTIALS);
  }

  const passwordOk = await verifyPassword(input.password, user.passwordHash);
  const inactive = !user.isActive || user.anonymisedAt !== null;
  if (!passwordOk || inactive) {
    auditFailure(db, user, input, inactive ? "inactive" : "bad_password");
    const after = recordLoginFailure(key);
    if (!after.allowed) throw new RateLimitedError(after.retryAfterSeconds);
    throw new UnauthorizedError(INVALID_CREDENTIALS);
  }

  resetLoginRateLimit(key);
  const ctx = buildContextFromDb(db, user.id, { sessionVersion: user.sessionVersion });
  if (!ctx) throw new UnauthorizedError(INVALID_CREDENTIALS);
  withTx(
    (tx) => {
      tx.update(users).set({ lastLoginAt: ctx.now() }).where(eq(users.id, user.id)).run();
      recordEvent(tx, ctx, {
        entityType: "auth",
        entityId: user.id,
        eventType: "auth.logged_in",
        action: "logged_in",
        previousValue: null,
        newValue: { email: user.email },
        metadata: { ip: input.ip ?? null, userAgent: input.userAgent ?? null },
        visibility: "management",
      });
    },
    { db },
  );

  return {
    id: user.id,
    organisationId: user.organisationId,
    name: user.name,
    email: user.email,
    role: user.role,
    sessionVersion: user.sessionVersion,
  };
}

/** Full login for route handlers / server actions: authenticate + set the cookie. */
export async function login(raw: unknown, db: Db = getDb()): Promise<AuthenticatedUser> {
  const user = await authenticate(db, raw);
  await createSession(user.id, user.sessionVersion);
  return user;
}

/** Audits `auth.logged_out` for a signed-in context (no-op for system contexts). */
export function recordLogout(tx: Tx, ctx: AuthContext, meta: { ip?: string | null; userAgent?: string | null } = {}): void {
  if (!ctx.userId) return;
  recordEvent(tx, ctx, {
    entityType: "auth",
    entityId: ctx.userId,
    eventType: "auth.logged_out",
    action: "logged_out",
    previousValue: null,
    newValue: null,
    metadata: { ip: meta.ip ?? null, userAgent: meta.userAgent ?? null },
    visibility: "management",
  });
}

/** Logout: audit (when signed in) + expire the cookie. Always succeeds. */
export async function logout(ctx: AuthContext | null, meta: { ip?: string | null; userAgent?: string | null } = {}): Promise<void> {
  if (ctx?.userId) {
    withTx((tx) => recordLogout(tx, ctx, meta));
  }
  await clearSession();
}

/**
 * Verifies the current password (async bcrypt) and hashes the new one,
 * outside any transaction. Returns what `changePasswordInDb` needs.
 */
export async function preparePasswordChange(
  db: Db,
  ctx: AuthContext,
  raw: unknown,
): Promise<{ userId: string; expectedVersion: number; passwordHash: string }> {
  if (!ctx.userId || ctx.isSystem) throw new UnauthorizedError();
  const input = parseInput(ChangePasswordInput, raw);
  const user = db.select().from(users).where(and(eq(users.id, ctx.userId), eq(users.organisationId, ctx.organisationId))).get();
  if (!user || !user.isActive) throw new UnauthorizedError();
  if (!(await verifyPassword(input.current, user.passwordHash))) {
    throw new ValidationError("Current password is incorrect", {
      formErrors: [],
      fieldErrors: { current: ["Current password is incorrect"] },
    });
  }
  return { userId: user.id, expectedVersion: user.version, passwordHash: await hashPassword(input.next) };
}

/**
 * Writes the new hash, bumps `session_version` (every other cookie dies) and
 * `version`, audits `user.password_changed`. Returns the new session version.
 */
export function changePasswordInDb(
  tx: Tx,
  ctx: AuthContext,
  prepared: { userId: string; expectedVersion: number; passwordHash: string },
): { sessionVersion: number } {
  if (!ctx.userId || ctx.userId !== prepared.userId) throw new UnauthorizedError();
  const now = ctx.now();
  const updated = tx
    .update(users)
    .set({
      passwordHash: prepared.passwordHash,
      sessionVersion: sql`${users.sessionVersion} + 1`,
      version: sql`${users.version} + 1`,
      updatedAt: now,
    })
    .where(and(eq(users.id, prepared.userId), eq(users.organisationId, ctx.organisationId), eq(users.version, prepared.expectedVersion)))
    .returning({ sessionVersion: users.sessionVersion, name: users.name })
    .get();
  if (!updated) throw new ConflictError("Your account was changed elsewhere. Reload and try again.");
  recordEvent(tx, ctx, {
    entityType: "user",
    entityId: prepared.userId,
    eventType: "user.password_changed",
    action: "updated",
    previousValue: { sessionVersion: updated.sessionVersion - 1 },
    newValue: { sessionVersion: updated.sessionVersion, name: updated.name },
    metadata: { targetUserId: prepared.userId, self: true },
    visibility: "management",
  });
  return { sessionVersion: updated.sessionVersion };
}

/**
 * Change your own password (any active user; verified by the current
 * password, so no POLICY rule — `user.reset_password` is the admin action
 * on other users). Re-issues this browser's cookie with the new version.
 */
export async function changePassword(ctx: AuthContext, raw: unknown, db: Db = getDb()): Promise<{ ok: true }> {
  const prepared = await preparePasswordChange(db, ctx, raw);
  const { sessionVersion } = withTx((tx) => changePasswordInDb(tx, ctx, prepared), { db });
  await createSession(prepared.userId, sessionVersion);
  return { ok: true };
}
