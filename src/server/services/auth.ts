/**
 * Authentication service: login, logout, change password (ARCHITECTURE.md §3.3).
 *
 * The DB halves (`authenticate`, `recordLogout`, `changePasswordInDb`) take
 * an explicit `db` and never touch cookies, so tests drive them directly.
 * `login` / `logout` / `changePassword` add the cookie side effects for
 * route handlers and server actions.
 *
 * Audit: `auth.logged_in` (via `recordSignIn`, src/server/auth/sign-in.ts, `metadata.method: "password"`),
 * `auth.login_failed` (only when the email matches
 * an account — events need an organisation; never the password),
 * `auth.logged_out` (logout also bumps `session_version`: all devices are
 * signed out), `user.password_changed`; all management-visibility.
 * `users.last_login_at` is an audit exemption (§5). Accounts: changing the password also closes a pending
 * email-change link and sends "Your password was changed" (`sendPasswordChangedNotice`).
 *
 * Limits (Postgres-backed, docs/ACCOUNTS.md §6): failed sign-ins per email + IP and per email — or, for a browser that
 * signed in to that address before, per browser (src/server/auth/known-device.ts, SEC-06) — and per client IP; wrong
 * current passwords per person (`passwordCheck`). Demo studio (docs/ACCOUNTS.md §7): the password cannot be changed
 * (`assertNotDemo(ctx, "password")`), signing out never revokes the shared persona's other sessions, and with
 * `DEMO_SIGN_IN=off` its people cannot sign in at all (DEMO-02: their seeded password is public).
 */
import { and, eq, sql } from "drizzle-orm";
import { first, getDb, type Db, type Tx } from "@/db/index";
import { users } from "@/db/schema";
import type { AuthContext, User } from "@/lib/types";
import { ChangePasswordInput, LoginInput } from "@/lib/validation/auth";
import { recordEvent } from "@/server/audit";
import { hasUsablePassword, hashPassword, verifyAgainstDummy, verifyPassword } from "@/server/auth/password";
import { checkLoginAttempt, limiters, recordLoginAttemptFailure, resetLoginAttempts, userKey } from "@/server/auth/db-rate-limit";
import { assertNotDemo, demoSignInEnabled, isDemoOrganisation } from "@/server/auth/demo";
import { currentKnownDevice, knownDeviceIdFor, type KnownDevice } from "@/server/auth/known-device";
import { buildContextFromDb, clearSession, systemContext } from "@/server/auth/session";
import { SIGN_IN_REFUSED_MESSAGE, issueSessionCookie, recordSignIn } from "@/server/auth/sign-in";
import { consumeLiveTokens } from "@/server/auth/tokens";
import { ConflictError, UnauthorizedError, ValidationError } from "@/server/errors";
import { WRONG_PASSWORD_MESSAGE } from "./account";
import { sendPasswordChangedNotice } from "./accountNotices";
import { limiterNow, plainRateLimited } from "./authLimits";
import { parseInput, withTx } from "./_shared";

const INVALID_CREDENTIALS = SIGN_IN_REFUSED_MESSAGE;

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

export interface AuthenticateOptions {
  /**
   * This browser's known-device cookie (src/server/auth/known-device.ts). When it signed in to this very address
   * before, its failures count under its own key instead of the per-email backstop (SEC-06).
   */
  device?: KnownDevice | null;
  /** Test seam for `DEMO_SIGN_IN`. */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Verifies credentials (rate-limited per email+IP AND per email alone — or, for a known browser, per browser — and
 * per client IP; Postgres-backed, so every server instance shares the count: src/server/auth/db-rate-limit.ts),
 * records the outcome and returns the user. Throws a 429 (`RateLimitedError`, "Too many sign-in attempts. Try again
 * in N minutes.") or UnauthorizedError (401, one generic message for unknown email / wrong password / inactive account
 * / invite not yet accepted / client user whose portal is off or whose client is archived / a person of the demo
 * studio while demo sign-in is off). Only failures count; a success clears the email+IP key and the browser's own key
 * (never the per-email backstop, so a victim's own sign-in cannot top an attacker back up).
 */
export async function authenticate(db: Db, raw: unknown, opts: AuthenticateOptions = {}): Promise<AuthenticatedUser> {
  const input = parseInput(LoginInput, raw);
  const nowMs = limiterNow();
  const scope = { deviceId: knownDeviceIdFor(opts.device, input.email) };
  const limit = await checkLoginAttempt(db, input.email, input.ip, nowMs, scope);
  if (!limit.allowed) throw plainRateLimited("sign_in", limit.retryAfterSeconds);

  /** Counts this failure; the attempt that uses up the last try is answered with the 429 straight away. */
  const refuse = async (): Promise<never> => {
    const after = await recordLoginAttemptFailure(db, input.email, input.ip, nowMs, scope);
    if (!after.allowed) throw plainRateLimited("sign_in", after.retryAfterSeconds);
    throw new UnauthorizedError(INVALID_CREDENTIALS);
  };

  const user = await first(db.select().from(users).where(eq(users.email, input.email)));
  if (!user) {
    await verifyAgainstDummy(input.password);
    return refuse();
  }

  // An unusable hash (pending invitee, Google-only, anonymised) still costs a full bcrypt (SEC-09: no timing oracle).
  const passwordOk = (await verifyPassword(input.password, user.passwordHash)) && hasUsablePassword(user);
  const inactive = !user.isActive || user.anonymisedAt !== null;
  // Front door: an invited person has no usable password until they accept their link (accepted_at null).
  const notAccepted = user.acceptedAt === null;
  if (!passwordOk || inactive || notAccepted) {
    await auditFailure(db, user, input, inactive ? "inactive" : notAccepted ? "not_accepted" : "bad_password");
    return refuse();
  }
  // DEMO-02: with demo sign-in off the demo studio is closed — its seeded password is public, so it opens nothing.
  if (!demoSignInEnabled(opts.env) && (await isDemoOrganisation(db, user.organisationId))) {
    await auditFailure(db, user, input, "demo_closed");
    return refuse();
  }

  const ctx = await buildContextFromDb(db, user.id, { sessionVersion: user.sessionVersion });
  if (!ctx) {
    // Roles v2 (docs/ROLES.md §7.8): a client user whose client is archived or has the
    // portal off gets the SAME generic 401 as a wrong password (no credential oracle).
    await auditFailure(db, user, input, user.role === "client" ? "portal_closed" : "no_context");
    return refuse();
  }
  await resetLoginAttempts(db, input.email, input.ip, scope);
  await withTx((tx) => recordSignIn(tx, ctx, { method: "password", ip: input.ip, userAgent: input.userAgent }), { db });

  return {
    id: user.id,
    organisationId: user.organisationId,
    name: user.name,
    email: user.email,
    role: user.role,
    sessionVersion: user.sessionVersion,
  };
}

/**
 * Full login for route handlers / server actions: authenticate (with this browser's known-device cookie) + set the
 * session cookie + remember this browser for the address.
 */
export async function login(raw: unknown, db: Db = getDb()): Promise<AuthenticatedUser> {
  const user = await authenticate(db, raw, { device: await currentKnownDevice() });
  await issueSessionCookie({ id: user.id, role: user.role, sessionVersion: user.sessionVersion, email: user.email });
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
 * In the demo studio nothing is revoked (shared persona accounts): the event is
 * still recorded (`allSessionsRevoked: false`) and the caller clears this cookie.
 */
export async function recordLogout(tx: Tx, ctx: AuthContext, meta: { ip?: string | null; userAgent?: string | null } = {}): Promise<number | null> {
  if (!ctx.userId || ctx.isSystem) return null;
  if (ctx.isDemo) {
    // The demo studio (docs/ACCOUNTS.md §7): every visitor shares the four persona accounts, so bumping the version
    // here would sign EVERY visitor out. Only this browser's cookie is cleared (by `logout`); nothing is revoked.
    await recordEvent(tx, ctx, {
      entityType: "auth",
      entityId: ctx.userId,
      eventType: "auth.logged_out",
      action: "logged_out",
      previousValue: null,
      newValue: null,
      metadata: { ip: meta.ip ?? null, userAgent: meta.userAgent ?? null, allSessionsRevoked: false, demo: true },
      visibility: "management",
    });
    return null;
  }
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
 * Refused in the demo studio (403 `demo.password`); a Google-only account (no password) gets 400
 * `fieldErrors.current`; wrong current passwords count toward `passwordCheck` (10 / 15 min per person → 429).
 */
export async function preparePasswordChange(
  db: Db,
  ctx: AuthContext,
  raw: unknown,
): Promise<{ userId: string; expectedVersion: number; passwordHash: string }> {
  if (!ctx.userId || ctx.isSystem) throw new UnauthorizedError();
  assertNotDemo(ctx, "password");
  const input = parseInput(ChangePasswordInput, raw);
  const user = await first(
    db
      .select()
      .from(users)
      .where(and(eq(users.id, ctx.userId), eq(users.organisationId, ctx.organisationId))),
  );
  if (!user || !user.isActive) throw new UnauthorizedError();
  if (!hasUsablePassword(user)) {
    // Google-only account: there is no current password to check (Settings → My account offers "Set a password").
    throw new ValidationError("This account has no password yet", {
      formErrors: [],
      fieldErrors: { current: ["This account has no password yet. Use “Set a password” instead."] },
    });
  }
  // Wrong current passwords are capped per person (RATE_LIMITS.passwordCheck, shared with the email change).
  const key = userKey(user.id);
  const nowMs = limiterNow();
  const gate = await limiters.passwordCheck.check(db, key, nowMs);
  if (!gate.allowed) throw plainRateLimited("password_check", gate.retryAfterSeconds);
  if (!(await verifyPassword(input.current, user.passwordHash))) {
    const after = await limiters.passwordCheck.hit(db, key, nowMs);
    if (!after.allowed) throw plainRateLimited("password_check", after.retryAfterSeconds);
    // One sentence for a wrong password across My account (UX-10): the same words as Change email.
    throw new ValidationError(WRONG_PASSWORD_MESSAGE, {
      formErrors: [],
      fieldErrors: { current: [WRONG_PASSWORD_MESSAGE] },
    });
  }
  return { userId: user.id, expectedVersion: user.version, passwordHash: await hashPassword(input.next) };
}

/**
 * Writes the new hash, bumps `session_version` (every other cookie dies) and
 * `version`, closes any pending email-change link (a password change cancels it),
 * audits `user.password_changed`. Returns the new session version.
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
  const emailChangesClosed = await consumeLiveTokens(tx, prepared.userId, "email_change", now);
  await recordEvent(tx, ctx, {
    entityType: "user",
    entityId: prepared.userId,
    eventType: "user.password_changed",
    action: "updated",
    previousValue: { sessionVersion: updated.sessionVersion - 1 },
    newValue: { sessionVersion: updated.sessionVersion, name: updated.name },
    metadata: { targetUserId: prepared.userId, self: true, ...(emailChangesClosed > 0 ? { emailChangesClosed } : {}) },
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
  await issueSessionCookie({ id: prepared.userId, role: ctx.role, sessionVersion });
  await sendPasswordChangedNotice(db, { userId: prepared.userId, via: "changed" });
  return { ok: true };
}
