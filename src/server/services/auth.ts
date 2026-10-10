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
 * `auth.logged_out` (logout also bumps `session_version`: all devices are
 * signed out), `user.password_changed`; all management-visibility.
 * `users.last_login_at` is an audit exemption (§5).
 */
import { and, eq, sql } from "drizzle-orm";
import { first, getDb, type Db, type Tx } from "@/db/index";
import { users } from "@/db/schema";
import type { AuthContext, User } from "@/lib/types";
import { ChangePasswordInput, LoginInput } from "@/lib/validation/auth";
import { recordEvent } from "@/server/audit";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "@/server/auth/password";
import { checkLoginAttempt, recordLoginAttemptFailure, resetLoginAttempts } from "@/server/auth/rate-limit";
import { buildContextFromDb, clearSession, createSession, sessionKindForRole, systemContext } from "@/server/auth/session";
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

async function auditFailure(db: Db, user: User, input: { email: string; ip?: string | null; userAgent?: string | null }, reason: string): Promise<void> {
  const ctx = await systemContext(user.organisationId, { db, cause: "user" });
  await withTx(
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
 * Verifies credentials (rate-limited per email+IP AND per email alone), records the outcome and
 * returns the user. Throws RateLimitedError (429) or UnauthorizedError (401,
 * one generic message for unknown email / wrong password / inactive account /
 * client user whose portal is off or whose client is archived).
 */
export async function authenticate(db: Db, raw: unknown): Promise<AuthenticatedUser> {
  const input = parseInput(LoginInput, raw);
  const limit = checkLoginAttempt(input.email, input.ip);
  if (!limit.allowed) throw new RateLimitedError(limit.retryAfterSeconds);

  const user = await first(db.select().from(users).where(eq(users.email, input.email)));
  if (!user) {
    await verifyAgainstDummy(input.password);
    const after = recordLoginAttemptFailure(input.email, input.ip);
    if (!after.allowed) throw new RateLimitedError(after.retryAfterSeconds);
    throw new UnauthorizedError(INVALID_CREDENTIALS);
  }

  const passwordOk = await verifyPassword(input.password, user.passwordHash);
  const inactive = !user.isActive || user.anonymisedAt !== null;
  if (!passwordOk || inactive) {
    await auditFailure(db, user, input, inactive ? "inactive" : "bad_password");
    const after = recordLoginAttemptFailure(input.email, input.ip);
    if (!after.allowed) throw new RateLimitedError(after.retryAfterSeconds);
    throw new UnauthorizedError(INVALID_CREDENTIALS);
  }

  const ctx = await buildContextFromDb(db, user.id, { sessionVersion: user.sessionVersion });
  if (!ctx) {
    // Roles v2 (docs/ROLES.md §7.8): a client user whose client is archived or has the
    // portal off gets the SAME generic 401 as a wrong password (no credential oracle).
    await auditFailure(db, user, input, user.role === "client" ? "portal_closed" : "no_context");
    const after = recordLoginAttemptFailure(input.email, input.ip);
    if (!after.allowed) throw new RateLimitedError(after.retryAfterSeconds);
    throw new UnauthorizedError(INVALID_CREDENTIALS);
  }
  resetLoginAttempts(input.email, input.ip);
  await withTx(
    async (tx) => {
      await tx.update(users).set({ lastLoginAt: ctx.now() }).where(eq(users.id, user.id));
      await recordEvent(tx, ctx, {
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
  await createSession(user.id, user.sessionVersion, sessionKindForRole(user.role));
  return user;
}

/**
 * Server-side sign-out for a signed-in context: bumps `users.session_version`
 * (so every cookie issued before — this browser's AND any copied or other-device
 * token — stops resolving) and audits `auth.logged_out` with the before/after
 * version, in the caller's transaction. No-op for system contexts. Returns the
 * new session version (null when nothing was revoked).
 *
 * Trade-off: signing out signs the user out on ALL devices (the session is a
 * stateless `{ sub, sv }` cookie; per-device revocation would need a session table).
 */
export async function recordLogout(tx: Tx, ctx: AuthContext, meta: { ip?: string | null; userAgent?: string | null } = {}): Promise<number | null> {
  if (!ctx.userId || ctx.isSystem) return null;
  const updated = await first(
    tx
      .update(users)
      .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
      .where(and(eq(users.id, ctx.userId), eq(users.organisationId, ctx.organisationId)))
      .returning({ sessionVersion: users.sessionVersion }),
  );
  if (!updated) return null;
  await recordEvent(tx, ctx, {
    entityType: "auth",
    entityId: ctx.userId,
    eventType: "auth.logged_out",
    action: "logged_out",
    previousValue: { sessionVersion: updated.sessionVersion - 1 },
    newValue: { sessionVersion: updated.sessionVersion },
    metadata: { ip: meta.ip ?? null, userAgent: meta.userAgent ?? null, allSessionsRevoked: true },
    visibility: "management",
  });
  return updated.sessionVersion;
}

/** Logout: revoke every session + audit (when signed in), then expire the cookie. Always succeeds. */
export async function logout(ctx: AuthContext | null, meta: { ip?: string | null; userAgent?: string | null } = {}, db: Db = getDb()): Promise<void> {
  if (ctx?.userId) {
    await withTx((tx) => recordLogout(tx, ctx, meta), { db });
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
  const user = await first(
    db
      .select()
      .from(users)
      .where(and(eq(users.id, ctx.userId), eq(users.organisationId, ctx.organisationId))),
  );
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
export async function changePasswordInDb(
  tx: Tx,
  ctx: AuthContext,
  prepared: { userId: string; expectedVersion: number; passwordHash: string },
): Promise<{ sessionVersion: number }> {
  if (!ctx.userId || ctx.userId !== prepared.userId) throw new UnauthorizedError();
  const now = ctx.now();
  const updated = await first(
    tx
      .update(users)
      .set({
        passwordHash: prepared.passwordHash,
        sessionVersion: sql`${users.sessionVersion} + 1`,
        version: sql`${users.version} + 1`,
        updatedAt: now,
      })
      .where(and(eq(users.id, prepared.userId), eq(users.organisationId, ctx.organisationId), eq(users.version, prepared.expectedVersion)))
      .returning({ sessionVersion: users.sessionVersion, name: users.name }),
  );
  if (!updated) throw new ConflictError("Your account was changed elsewhere. Reload and try again.");
  await recordEvent(tx, ctx, {
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
  const { sessionVersion } = await withTx((tx) => changePasswordInDb(tx, ctx, prepared), { db });
  await createSession(prepared.userId, sessionVersion, sessionKindForRole(ctx.role));
  return { ok: true };
}
