/**
 * Self-service password reset (front door). The owner-side reset (a temp password read out to the person,
 * `resetPassword` in ./users.ts) stays as the fallback.
 *
 *   requestPasswordReset(db, { email, ip })  public; ALWAYS `{ ok: true }` (no account oracle). A 60-minute
 *                                            token is created only for an active, accepted, non-anonymised user
 *                                            (one live token per user: older ones are superseded); audited
 *                                            `auth.password_reset_requested` (management visibility, actor null);
 *                                            emailed when email is configured; 5 requests / 15 min per email+IP
 *   resetPassword(db, { token, password })   public; generic 400 for anything invalid; sets the password, bumps
 *                                            `session_version` (every other session dies), marks the token used,
 *                                            audits `user.password_changed` with cause "reset"
 */
import { eq } from "drizzle-orm";
import { first, getDb, type Db } from "@/db/index";
import { organisations, users } from "@/db/schema";
import type { Role } from "@/lib/constants";
import { ForgotPasswordInput, ResetPasswordInput } from "@/lib/validation/auth";
import { recordEvent } from "@/server/audit";
import { hashPassword } from "@/server/auth/password";
import { checkPasswordResetRequest, recordPasswordResetRequest } from "@/server/auth/rate-limit";
import { buildContextFromDb, createSession, sessionKindForRole, systemContext } from "@/server/auth/session";
import { findLiveToken, issueToken, markTokenUsed } from "@/server/auth/tokens";
import { nowIso } from "@/server/clock";
import { emailConfigured, sendEmail } from "@/server/email";
import { passwordResetEmail } from "@/server/email/templates";
import { RateLimitedError, ValidationError } from "@/server/errors";
import { passwordResetUrl } from "@/server/origin";
import { currentRequestId, newRequestId } from "@/server/request-scope";
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
  const limit = checkPasswordResetRequest(input.email, input.ip);
  if (!limit.allowed) throw new RateLimitedError(limit.retryAfterSeconds);
  recordPasswordResetRequest(input.email, input.ip);

  const user = await first(db.select().from(users).where(eq(users.email, input.email)));
  if (!user || !resettable(user)) return { ok: true, emailed: false };

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
  if (!configured) {
    return process.env.NODE_ENV === "production" ? { ok: true, emailed: false } : { ok: true, emailed: false, resetUrl: url };
  }
  const org = await first(db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, user.organisationId)));
  const sent = await sendEmail({ to: user.email, ...passwordResetEmail({ resetUrl: url, expiresAt: issued.expiresAt, studioName: org?.name ?? null }) });
  return { ok: true, emailed: sent.ok };
}

export interface ResetPasswordResult {
  userId: string;
  organisationId: string;
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
  const passwordHash = await hashPassword(input.password);
  return withTx(
    async (tx) => {
      const now = nowIso();
      const token = await findLiveToken(tx, input.token, "password_reset", now);
      if (!token) throw invalidReset();
      const user = await first(tx.select().from(users).where(eq(users.id, token.userId)));
      if (!user || !resettable(user)) throw invalidReset();
      const ctx = await buildContextFromDb(tx, user.id, { cause: "reset", requestId: opts.requestId ?? currentRequestId() ?? newRequestId() });
      if (!ctx) throw invalidReset();
      if (!(await markTokenUsed(tx, token.id, now))) throw invalidReset();
      const nextSession = user.sessionVersion + 1;
      await tx
        .update(users)
        .set({ passwordHash, sessionVersion: nextSession, updatedAt: now, version: user.version + 1 })
        .where(eq(users.id, user.id));
      await recordEvent(tx, ctx, {
        entityType: "user",
        entityId: user.id,
        eventType: "user.password_changed",
        action: "updated",
        previousValue: { sessionVersion: user.sessionVersion },
        newValue: { sessionVersion: nextSession, name: user.name },
        metadata: { targetUserId: user.id, self: true, reset: true, via: "reset_link", ip: input.ip ?? null, userAgent: input.userAgent ?? null },
        visibility: "management",
      });
      return { userId: user.id, organisationId: user.organisationId, role: user.role, sessionVersion: nextSession };
    },
    { db },
  );
}

/** Reset + sign the person in on this browser (route handlers). */
export async function resetPasswordAndSignIn(raw: unknown, opts: { requestId?: string; db?: Db } = {}): Promise<ResetPasswordResult> {
  const result = await resetPassword(opts.db ?? getDb(), raw, opts);
  await createSession(result.userId, result.sessionVersion, sessionKindForRole(result.role), result.role);
  return result;
}
