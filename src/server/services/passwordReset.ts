/**
 * Self-service password reset (front door). The owner-side reset (a temp password read out to the person,
 * `resetPassword` in ./users.ts) stays as the fallback.
 *
 *   requestPasswordReset(db, { email, ip })  public; ALWAYS `{ ok: true }` (no account oracle). A 60-minute
 *                                            token is created only for an active, accepted, non-anonymised user
 *                                            (one live token per user: older ones are superseded); audited
 *                                            `auth.password_reset_requested` (management visibility, actor null);
 *                                            emailed when email is configured; 5 requests / 15 min per email+IP
 *                                            (Postgres-backed, plain-words 429); never a token for a person of
 *                                            the demo studio
 *   resetPassword(db, { token, password })   public; generic 400 for anything invalid (also: the demo studio); dead
 *                                            links are capped per client IP (`resetLinkLimiter`, checked before
 *                                            bcrypt); sets the password, bumps
 *                                            `session_version` (every other session dies), marks the token used,
 *                                            audits `user.password_changed` with cause "reset"; accounts: the
 *                                            email counts as confirmed (the link reached it), `has_password` = true,
 *                                            a pending email change is closed, the wrong passwords typed for the
 *                                            address are forgotten (UX-01: the new password works at once), and "Your
 *                                            password was changed" goes out after commit (`resetPasswordAndSignIn`,
 *                                            which also remembers this browser for the address)
 *
 * The reset email goes through `sendAccountEmail` (never from a demo studio; the dev-only `resetUrl` only outside
 * production when email is not configured or failed).
 */
import { eq } from "drizzle-orm";
import { first, getDb, type Db } from "@/db/index";
import { organisations, users } from "@/db/schema";
import type { Role } from "@/lib/constants";
import { ForgotPasswordInput, ResetPasswordInput } from "@/lib/validation/auth";
import { recordEvent } from "@/server/audit";
import { hashPassword } from "@/server/auth/password";
import { clearLoginLockout, emailIpKey } from "@/server/auth/db-rate-limit";
import { markEmailConfirmed } from "@/server/auth/email-confirmation";
import { buildContextFromDb, systemContext } from "@/server/auth/session";
import { issueSessionCookie } from "@/server/auth/sign-in";
import { consumeLiveTokens, findLiveToken, issueToken, markTokenUsed } from "@/server/auth/tokens";
import { nowIso } from "@/server/clock";
import { emailConfigured } from "@/server/email";
import { sendAccountEmail } from "@/server/email/account";
import { passwordResetEmail } from "@/server/email/templates";
import { ValidationError } from "@/server/errors";
import { passwordResetUrl } from "@/server/origin";
import { currentRequestId, newRequestId } from "@/server/request-scope";
import { sendPasswordChangedNotice } from "./accountNotices";
import { enforceLimit, limiterNow, plainRateLimited, resetLinkKey, resetLinkLimiter } from "./authLimits";
import { parseInput, withTx } from "./_shared";

export const RESET_INVALID_MESSAGE = "This reset link is no longer valid";

export interface RequestPasswordResetResult {
  ok: true;
  /** True when a reset email went out. Always false for unknown / inactive accounts — and never say which. */
  emailed: boolean;
  /**
   * Local development only (NODE_ENV !== "production" AND email not configured): the link, so the flow can be
   * exercised without a mail provider. Never present in production.
   */
  resetUrl?: string;
}

function invalidReset(): ValidationError {
  return new ValidationError(RESET_INVALID_MESSAGE, { formErrors: [RESET_INVALID_MESSAGE], fieldErrors: {} });
}

/** Can this account reset its password through a link? (active, accepted, not anonymised) */
function resettable(user: { isActive: boolean; acceptedAt: string | null; anonymisedAt: string | null }): boolean {
  return user.isActive && user.acceptedAt !== null && user.anonymisedAt === null;
}

/**
 * POST /api/auth/forgot-password `{ email }`. Rate-limited per email + IP (429 beyond 5 / 15 min); otherwise
 * always ok. Creates + emails a token only for a resettable account.
 */
export async function requestPasswordReset(db: Db, raw: unknown, opts: { req?: Request | null; requestId?: string } = {}): Promise<RequestPasswordResetResult> {
  const input = parseInput(ForgotPasswordInput, raw);
  await enforceLimit(db, "passwordReset", emailIpKey(input.email, input.ip), "forgot_password");

  const row = await first(
    db.select({ user: users, isDemo: organisations.isDemo }).from(users).innerJoin(organisations, eq(organisations.id, users.organisationId)).where(eq(users.email, input.email)),
  );
  // The demo studio's people share one password nobody may change: no token at all (same answer as anyone else).
  if (!row || row.isDemo || !resettable(row.user)) return { ok: true, emailed: false };
  const user = row.user;

  const requestId = opts.requestId ?? currentRequestId() ?? newRequestId();
  const configured = emailConfigured();
  const issued = await withTx(
    async (tx) => {
      const now = nowIso();
      const token = await issueToken(tx, { organisationId: user.organisationId, userId: user.id, kind: "password_reset", createdByUserId: null, now });
      const ctx = await systemContext(user.organisationId, { db: tx, cause: "user", requestId });
      await recordEvent(tx, ctx, {
        entityType: "auth",
        entityId: user.id,
        eventType: "auth.password_reset_requested",
        action: "requested",
        previousValue: null,
        newValue: { email: user.email, expiresAt: token.expiresAt },
        metadata: { targetUserId: user.id, ip: input.ip ?? null, userAgent: input.userAgent ?? null, superseded: token.superseded, emailed: configured },
        visibility: "management",
      });
      return token;
    },
    { db },
  );

  const url = passwordResetUrl(issued.token, opts.req);
  const org = await first(db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, user.organisationId)));
  const sent = await sendAccountEmail(db, {
    userId: user.id,
    to: user.email,
    content: passwordResetEmail({ resetUrl: url, expiresAt: issued.expiresAt, studioName: org?.name ?? null }),
    link: url,
  });
  // The dev-only link: local development without a working mail provider (never in production, never for a demo).
  return sent.devLink ? { ok: true, emailed: false, resetUrl: sent.devLink } : { ok: true, emailed: sent.sent };
}

export interface ResetPasswordResult {
  userId: string;
  organisationId: string;
  /** The account's address (the reset link reached it). */
  email: string;
  role: Role;
  sessionVersion: number;
}

/**
 * POST /api/auth/reset-password `{ token, password }`. Generic 400 for an unknown / expired / used token or a
 * non-resettable account. Writes the new hash, bumps `session_version` and `version`, marks the token used,
 * audits `user.password_changed` (cause "reset", `metadata.reset = true`).
 */
export async function resetPassword(db: Db, raw: unknown, opts: { requestId?: string } = {}): Promise<ResetPasswordResult> {
  const input = parseInput(ResetPasswordInput, raw);
  // Dead links per client IP (authLimits.ts): checked BEFORE the bcrypt below, so a stranger posting made-up links
  // cannot keep the server hashing; only dead links count, never a successful reset.
  const limitKey = resetLinkKey(input.ip);
  const nowMs = limiterNow();
  if (limitKey) {
    const gate = await resetLinkLimiter.check(db, limitKey, nowMs);
    if (!gate.allowed) throw plainRateLimited("reset_link", gate.retryAfterSeconds);
  }
  const passwordHash = await hashPassword(input.password);
  let result: ResetPasswordResult;
  try {
    result = await applyReset(db, input, passwordHash, opts);
  } catch (err) {
    if (limitKey && err instanceof ValidationError && err.message === RESET_INVALID_MESSAGE) await resetLinkLimiter.hit(db, limitKey, nowMs);
    throw err;
  }
  // UX-01: the person just proved they own this address — wrong passwords typed for it before (theirs or anyone's)
  // must not refuse the new one with "Too many sign-in attempts".
  await clearLoginLockout(db, result.email, input.ip);
  return result;
}

async function applyReset(db: Db, input: ResetPasswordInput, passwordHash: string, opts: { requestId?: string }): Promise<ResetPasswordResult> {
  return withTx(
    async (tx) => {
      const now = nowIso();
      const token = await findLiveToken(tx, input.token, "password_reset", now);
      if (!token) throw invalidReset();
      const user = await first(tx.select().from(users).where(eq(users.id, token.userId)));
      if (!user || !resettable(user)) throw invalidReset();
      const ctx = await buildContextFromDb(tx, user.id, { cause: "reset", requestId: opts.requestId ?? currentRequestId() ?? newRequestId() });
      // The demo studio's shared passwords never change (a link issued before the studio became the demo is dead too).
      if (!ctx || ctx.isDemo) throw invalidReset();
      if (!(await markTokenUsed(tx, token.id, now))) throw invalidReset();
      const nextSession = user.sessionVersion + 1;
      await tx
        .update(users)
        .set({ passwordHash, hasPassword: true, sessionVersion: nextSession, updatedAt: now, version: user.version + 1 })
        .where(eq(users.id, user.id));
      // A new password closes a pending email change ("change your password now: that cancels the change").
      const emailChangesClosed = await consumeLiveTokens(tx, user.id, "email_change", now);
      await recordEvent(tx, ctx, {
        entityType: "user",
        entityId: user.id,
        eventType: "user.password_changed",
        action: "updated",
        previousValue: { sessionVersion: user.sessionVersion },
        newValue: { sessionVersion: nextSession, name: user.name },
        metadata: {
          targetUserId: user.id,
          self: true,
          reset: true,
          via: "reset_link",
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          ...(emailChangesClosed > 0 ? { emailChangesClosed } : {}),
        },
        visibility: "management",
      });
      // The reset link reached this address: it is confirmed (accounts).
      await markEmailConfirmed(tx, ctx, { userId: user.id, via: "reset" });
      return { userId: user.id, organisationId: user.organisationId, email: user.email, role: user.role, sessionVersion: nextSession };
    },
    { db },
  );
}

/** Reset + sign the person in on this browser (route handlers), then "Your password was changed". */
export async function resetPasswordAndSignIn(raw: unknown, opts: { requestId?: string; db?: Db } = {}): Promise<ResetPasswordResult> {
  const db = opts.db ?? getDb();
  const result = await resetPassword(db, raw, opts);
  await issueSessionCookie({ id: result.userId, role: result.role, sessionVersion: result.sessionVersion, email: result.email });
  await sendPasswordChangedNotice(db, { userId: result.userId, via: "reset" });
  return result;
}
