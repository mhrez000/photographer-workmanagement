/**
 * Settings → My account: the signed-in person looks after their own sign-in details (docs/ACCOUNTS.md "My account";
 * contract docs/ACCOUNTS-PLAN.md §4 "AREA account"). Every function is SELF-ONLY (staff and clients alike — the
 * routes use `requireAnyContext`) except `confirmEmailChange`, which is public: the link proves the new address.
 *
 *   requestEmailChange(db, ctx, raw)   new email + current password. Email configured → a 24-hour link to the NEW
 *                                      address + "someone asked to change your email" to the OLD one; nothing
 *                                      changes until the link is opened. Not configured → the address changes at
 *                                      once and counts as unconfirmed. 5 requests / hour; wrong passwords also
 *                                      count against the shared `passwordCheck` limit (10 / 15 min).
 *   resendEmailChange(db, ctx)         "Send again": a fresh link for the waiting change (the older one stops
 *                                      working). No password: it can only go to the address already chosen with it.
 *   cancelEmailChange(db, ctx)         closes the waiting change
 *   confirmEmailChange(db, raw)        public: the button on /change-email → the address changes (and is confirmed:
 *                                      the link reached it); "Your Proofline email was changed" to the old address
 *   setPassword(db, ctx, raw)          a first password for an account without one (Google sign-ups)
 *   signOutOtherDevices(db, ctx)       bumps `session_version` (every cookie dies) and re-issues THIS browser's cookie
 *
 * Every change refuses in the demo studio (`assertNotDemo`, plain 403 copy). Mutations run in ONE transaction with
 * their audit event; emails go out through `sendAccountEmail` AFTER the commit (never from a demo studio, a dev-only
 * link outside production). Plain tokens are returned once to the caller, never stored, logged or audited.
 *
 * Audit (plan §5, all management visibility): `user.email_change_requested` (requested), `user.email_change_cancelled`
 * (revoked), `user.email_changed` (updated, `via` "link" | "direct"), `user.email_confirmed` (via "email_change"),
 * `user.password_changed` (`self: true, via: "set"`), `auth.other_sessions_revoked` (revoked).
 */
import { and, eq, ne, sql } from "drizzle-orm";
import { first, type Db, type DbLike, type Tx } from "@/db/index";
import { isUniqueViolation } from "@/db/errors";
import { users } from "@/db/schema";
import type { Role } from "@/lib/constants";
import type { AuthContext, User } from "@/lib/types";
import { ChangeEmailInput, ConfirmEmailChangeInput, SetPasswordInput } from "@/lib/validation/auth";
import { recordEvent } from "@/server/audit";
import { enforceRateLimit, limiters, userKey } from "@/server/auth/db-rate-limit";
import { assertNotDemo } from "@/server/auth/demo";
import { clearEmailConfirmation, markEmailConfirmed } from "@/server/auth/email-confirmation";
import { hasUsablePassword, hashPassword, verifyPassword } from "@/server/auth/password";
import { buildContextFromDb, systemContext } from "@/server/auth/session";
import { issueSessionCookie } from "@/server/auth/sign-in";
import { consumeLiveTokens, findLiveToken, issueToken, latestLiveToken, markTokenUsed } from "@/server/auth/tokens";
import { nowIso } from "@/server/clock";
import { accountEmailBlock, sendAccountEmail, type AccountEmailNotSentReason, type AccountEmailOptions } from "@/server/email/account";
import { confirmNewEmailEmail } from "@/server/email/templates";
import { ConflictError, ForbiddenError, RateLimitedError, RuleViolationError, UnauthorizedError, ValidationError } from "@/server/errors";
import { confirmEmailChangeUrl } from "@/server/origin";
import { currentRequestId, newRequestId } from "@/server/request-scope";
import { sendEmailChangedNotice, sendPasswordChangedNotice } from "./accountNotices";
import { parseInput, withTx } from "./_shared";

/* ------------------------------------------------------------------ */
/*  Copy (shown as-is by the forms)                                    */
/* ------------------------------------------------------------------ */

export const SAME_EMAIL_MESSAGE = "That’s already your email";
export const EMAIL_TAKEN_MESSAGE = "That email is already in use";
export const WRONG_PASSWORD_MESSAGE = "That password isn’t right";
export const NO_PASSWORD_FOR_EMAIL_MESSAGE = "Set a password first, then you can change your email";
export const NO_PENDING_CHANGE_MESSAGE = "There is no email change waiting. Start again with the new email.";
export const ALREADY_HAS_PASSWORD_MESSAGE = "You already have a password. Use Change password.";
/** How recent a sign-in "Set a password" needs (SEC-03). */
export const RECENT_SIGN_IN_MINUTES = 15;
/** A Google-only account adding a password from a session that was not signed in recently (403 `account.recent_sign_in`). */
export const RECENT_SIGN_IN_MESSAGE = "For your safety, sign in again (Continue with Google) before adding a password. Then come back here.";

/** Did this browser really sign in within RECENT_SIGN_IN_MINUTES? (the session cookie's `at`, on the context) */
export function signedInRecently(ctx: Pick<AuthContext, "signedInAt" | "now">): boolean {
  if (!ctx.signedInAt) return false;
  const nowSeconds = Math.floor(Date.parse(ctx.now()) / 1000);
  return nowSeconds - ctx.signedInAt <= RECENT_SIGN_IN_MINUTES * 60 && ctx.signedInAt <= nowSeconds + 60;
}
/** The one answer for a dead /change-email link (unknown, used, expired, superseded, cancelled, deactivated). */
export const EMAIL_CHANGE_INVALID_MESSAGE = "This email change link is no longer valid";
/** The new address was taken by another account between the request and the confirm. */
export const EMAIL_NOW_TAKEN_MESSAGE = "That email is now used by another account";

/** `details.reason` of the two /change-email refusals, so the page can tell them apart without parsing copy. */
export type EmailChangeRefusal = "invalid_link" | "email_taken";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface AccountRequestOptions {
  /** The request (links in emails use its origin outside production, `APP_URL` in production). */
  req?: Request | null;
  requestId?: string;
  /** Test seams for the account emails (`env` decides "configured" / production; `send` replaces the provider). */
  email?: AccountEmailOptions;
}

/** POST /api/auth/email-change with email set up: a link went to the new address. */
export interface EmailChangePending {
  status: "pending";
  newEmail: string;
  /** When the link stops working (ISO). */
  expiresAt: string;
  /** The link was emailed to the new address. */
  sent: boolean;
  /** Why not (null when sent). */
  reason: AccountEmailNotSentReason | null;
  /** Development only (no working mail provider): the link to show instead. Never in production. */
  devLink?: string;
}

/** POST /api/auth/email-change without email set up: the address changed at once (now unconfirmed). */
export interface EmailChangeApplied {
  status: "changed";
  email: string;
}

export type EmailChangeResult = EmailChangePending | EmailChangeApplied;

export interface ConfirmEmailChangeResult {
  userId: string;
  organisationId: string;
  role: Role;
  /** The account's address now. */
  email: string;
  /** The address it had before. */
  previousEmail: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** The signed-in person's own row (org-scoped); 401 for system contexts, missing or inactive accounts. */
async function loadSelf(db: DbLike, ctx: AuthContext): Promise<User> {
  if (!ctx.userId || ctx.isSystem) throw new UnauthorizedError();
  const user = await first(db.select().from(users).where(and(eq(users.id, ctx.userId), eq(users.organisationId, ctx.organisationId))));
  if (!user || !user.isActive || user.anonymisedAt !== null) throw new UnauthorizedError();
  return user;
}

/** The services' clock in ms (real time in production; tests move it with `fakeClock`), shared with Change password. */
function limiterNow(): number {
  return Date.parse(nowIso());
}

/** A 429 whose message says what was limited and how long to wait (`retry-after` still comes from the seconds). */
function rateLimited(lead: string, retryAfterSeconds: number): RateLimitedError {
  const err = new RateLimitedError(retryAfterSeconds);
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  err.message = `${lead} Try again in ${minutes === 1 ? "a minute" : `${minutes} minutes`}.`;
  return err;
}

function fieldError(field: string, message: string): ValidationError {
  return new ValidationError(message, { formErrors: [], fieldErrors: { [field]: [message] } });
}

function rule(message: string): RuleViolationError {
  return new RuleViolationError(message, { formErrors: [message], fieldErrors: {} });
}

function emailChangeRefused(reason: EmailChangeRefusal): ValidationError {
  const message = reason === "email_taken" ? EMAIL_NOW_TAKEN_MESSAGE : EMAIL_CHANGE_INVALID_MESSAGE;
  return new ValidationError(message, { formErrors: [message], fieldErrors: {}, reason });
}

/** Is `email` the address of any account other than `userId` (any studio, any state)? */
async function emailUsedByAnother(db: DbLike, email: string, userId: string): Promise<boolean> {
  return (await first(db.select({ id: users.id }).from(users).where(and(eq(users.email, email), ne(users.id, userId))))) !== undefined;
}

/**
 * Checks the current password with the shared `passwordCheck` limiter (wrong passwords per person, shared with
 * Change password and Connect Google): 429 while over the limit; a wrong one is counted and answered with a field
 * error on `field`.
 */
export async function checkCurrentPassword(db: Db, user: User, password: string, field: string): Promise<void> {
  const key = userKey(user.id);
  const nowMs = limiterNow();
  const before = await limiters.passwordCheck.check(db, key, nowMs);
  if (!before.allowed) throw rateLimited("Too many wrong passwords.", before.retryAfterSeconds);
  if (await verifyPassword(password, user.passwordHash)) return;
  const after = await limiters.passwordCheck.hit(db, key, nowMs);
  if (!after.allowed) throw rateLimited("Too many wrong passwords.", after.retryAfterSeconds);
  throw fieldError(field, WRONG_PASSWORD_MESSAGE);
}

/** 5 email-change requests (and "Send again"s) an hour per person — every attempt counts. */
async function enforceEmailChangeLimit(db: Db, userId: string): Promise<void> {
  try {
    await enforceRateLimit(db, "emailChange", userKey(userId), limiterNow());
  } catch (err) {
    if (err instanceof RateLimitedError) throw rateLimited("Too many email changes asked for.", err.retryAfterSeconds);
    throw err;
  }
}

/** Emails "Confirm your new email address" to the NEW address (after the commit that issued the link). */
async function sendConfirmNewEmail(
  db: Db,
  input: { user: User; newEmail: string; token: string; expiresAt: string; timezone: string },
  opts: AccountRequestOptions,
): Promise<{ sent: boolean; reason: AccountEmailNotSentReason | null; devLink?: string }> {
  const url = confirmEmailChangeUrl(input.token, opts.req);
  const content = confirmNewEmailEmail({ name: input.user.name, newEmail: input.newEmail, confirmUrl: url, expiresAt: input.expiresAt, timezone: input.timezone });
  const result = await sendAccountEmail(db, { userId: input.user.id, to: input.newEmail, content, link: url }, opts.email);
  return { sent: result.sent, reason: result.reason, ...(result.devLink ? { devLink: result.devLink } : {}) };
}

/* ------------------------------------------------------------------ */
/*  Email change                                                       */
/* ------------------------------------------------------------------ */

/**
 * POST /api/auth/email-change `{ newEmail, password }`. Refusals, in order: demo studio (403); no password yet
 * (422 — Google-only accounts set one first); over 5 requests / hour (429); wrong current password (400
 * `fieldErrors.password`, counted by `passwordCheck`); the same address (400 `fieldErrors.newEmail`); an address
 * any account already uses (400 `fieldErrors.newEmail`). Email configured → `{ status: "pending" }` (link to the new
 * address, notice to the old); not configured → `{ status: "changed" }` (applied now, unconfirmed).
 */
export async function requestEmailChange(db: Db, ctx: AuthContext, raw: unknown, opts: AccountRequestOptions = {}): Promise<EmailChangeResult> {
  if (!ctx.userId || ctx.isSystem) throw new UnauthorizedError();
  assertNotDemo(ctx, "email");
  const input = parseInput(ChangeEmailInput, raw);
  const user = await loadSelf(db, ctx);
  if (!hasUsablePassword(user)) throw rule(NO_PASSWORD_FOR_EMAIL_MESSAGE);
  await enforceEmailChangeLimit(db, user.id);
  await checkCurrentPassword(db, user, input.password, "password");
  if (input.newEmail === user.email) throw fieldError("newEmail", SAME_EMAIL_MESSAGE);
  if (await emailUsedByAnother(db, input.newEmail, user.id)) throw fieldError("newEmail", EMAIL_TAKEN_MESSAGE);

  const meta = { ip: input.ip ?? null, userAgent: input.userAgent ?? null };
  const block = await accountEmailBlock(db, { userId: user.id }, { env: opts.email?.env });
  if (block === "demo") assertNotDemo({ isDemo: true }, "email"); // belt and braces: the studio became a demo

  if (block === null) {
    // Email is set up: nothing changes until the link sent to the NEW address is opened.
    const issued = await withTx(
      async (tx) => {
        const token = await issueToken(tx, {
          organisationId: user.organisationId,
          userId: user.id,
          kind: "email_change",
          createdByUserId: user.id,
          now: ctx.now(),
          targetEmail: input.newEmail,
        });
        await recordEvent(tx, ctx, {
          entityType: "user",
          entityId: user.id,
          eventType: "user.email_change_requested",
          action: "requested",
          previousValue: { email: user.email },
          newValue: { pendingEmail: input.newEmail, expiresAt: token.expiresAt },
          metadata: { targetUserId: user.id, superseded: token.superseded, ...meta },
          visibility: "management",
        });
        return token;
      },
      { db },
    );
    const sent = await sendConfirmNewEmail(db, { user, newEmail: input.newEmail, token: issued.token, expiresAt: issued.expiresAt, timezone: ctx.settings.timezone }, opts);
    await sendEmailChangedNotice(db, { userId: user.id, oldEmail: user.email, newEmail: input.newEmail, stage: "requested" }, opts.email);
    return { status: "pending", newEmail: input.newEmail, expiresAt: issued.expiresAt, ...sent };
  }

  // No email provider: a link could never arrive, so the change applies now and the new address is unconfirmed.
  try {
    await withTx(
      async (tx) => {
        const now = ctx.now();
        const updated = await first(
          tx
            .update(users)
            .set({ email: input.newEmail, version: sql`${users.version} + 1`, updatedAt: now })
            .where(and(eq(users.id, user.id), eq(users.organisationId, user.organisationId), eq(users.version, user.version)))
            .returning({ id: users.id }),
        );
        if (!updated) throw new ConflictError("Your account was changed elsewhere. Reload and try again.");
        await clearEmailConfirmation(tx, { userId: user.id, now });
        await recordEvent(tx, ctx, {
          entityType: "user",
          entityId: user.id,
          eventType: "user.email_changed",
          action: "updated",
          previousValue: { email: user.email },
          newValue: { email: input.newEmail, name: user.name },
          metadata: { targetUserId: user.id, via: "direct", ...meta },
          visibility: "management",
        });
      },
      { db },
    );
  } catch (err) {
    // Two people claiming the same address at the same moment: the unique index decides.
    if (isUniqueViolation(err, "users_email_uq")) throw fieldError("newEmail", EMAIL_TAKEN_MESSAGE);
    throw err;
  }
  return { status: "changed", email: input.newEmail };
}

/**
 * POST /api/auth/email-change/resend — "Send again" for the waiting change: a fresh link to the SAME new address
 * (the older link stops working). Counts against the 5-per-hour email-change limit. No waiting change → 422. The
 * address taken by another account meanwhile → the change is closed and 400 `EMAIL_NOW_TAKEN_MESSAGE`.
 */
export async function resendEmailChange(db: Db, ctx: AuthContext, opts: AccountRequestOptions = {}): Promise<EmailChangePending> {
  if (!ctx.userId || ctx.isSystem) throw new UnauthorizedError();
  assertNotDemo(ctx, "email");
  const user = await loadSelf(db, ctx);
  const pending = await latestLiveToken(db, user.id, "email_change", ctx.now());
  if (!pending?.targetEmail) throw rule(NO_PENDING_CHANGE_MESSAGE);
  await enforceEmailChangeLimit(db, user.id);
  const newEmail = pending.targetEmail;

  if (await emailUsedByAnother(db, newEmail, user.id)) {
    await withTx((tx) => closePendingChange(tx, ctx, user.id, { reason: "taken" }), { db });
    throw new ValidationError(EMAIL_NOW_TAKEN_MESSAGE, { formErrors: [EMAIL_NOW_TAKEN_MESSAGE], fieldErrors: {}, reason: "email_taken" });
  }

  const issued = await withTx(
    async (tx) => {
      const token = await issueToken(tx, { organisationId: user.organisationId, userId: user.id, kind: "email_change", createdByUserId: user.id, now: ctx.now(), targetEmail: newEmail });
      await recordEvent(tx, ctx, {
        entityType: "user",
        entityId: user.id,
        eventType: "user.email_change_requested",
        action: "requested",
        previousValue: { email: user.email },
        newValue: { pendingEmail: newEmail, expiresAt: token.expiresAt },
        metadata: { targetUserId: user.id, superseded: token.superseded, resend: true },
        visibility: "management",
      });
      return token;
    },
    { db },
  );
  const sent = await sendConfirmNewEmail(db, { user, newEmail, token: issued.token, expiresAt: issued.expiresAt, timezone: ctx.settings.timezone }, opts);
  return { status: "pending", newEmail, expiresAt: issued.expiresAt, ...sent };
}

/** In `tx`: consumes the person's live email-change links and audits the cancellation (when there was one). */
async function closePendingChange(tx: Tx, ctx: AuthContext, userId: string, extra: Record<string, unknown> = {}): Promise<number> {
  const now = ctx.now();
  const pending = await latestLiveToken(tx, userId, "email_change", now);
  const cancelled = await consumeLiveTokens(tx, userId, "email_change", now);
  if (cancelled > 0) {
    await recordEvent(tx, ctx, {
      entityType: "user",
      entityId: userId,
      eventType: "user.email_change_cancelled",
      action: "revoked",
      previousValue: null,
      newValue: { pendingEmail: pending?.targetEmail ?? null },
      metadata: { targetUserId: userId, cancelled, ...extra },
      visibility: "management",
    });
  }
  return cancelled;
}

/** POST /api/auth/email-change/cancel → `{ cancelled }` (how many waiting links were closed; 0 = nothing was waiting). */
export async function cancelEmailChange(db: Db, ctx: AuthContext): Promise<{ cancelled: number }> {
  if (!ctx.userId || ctx.isSystem) throw new UnauthorizedError();
  assertNotDemo(ctx, "email");
  const user = await loadSelf(db, ctx);
  const cancelled = await withTx((tx) => closePendingChange(tx, ctx, user.id), { db });
  return { cancelled };
}

/**
 * POST /api/auth/email-change/confirm `{ token }` — public (the button on /change-email; never on GET). A live
 * link of an active account → the address becomes the new one, confirmed (the link reached it), `users.version`
 * + 1; audits `user.email_changed` (via "link") and `user.email_confirmed` (via "email_change"); after the commit
 * "Your Proofline email was changed" goes to the OLD address. Never signs anyone in.
 *
 * Refusals (400, formErrors only, `details.reason`): any dead link → `EMAIL_CHANGE_INVALID_MESSAGE`
 * ("invalid_link"); the new address now used by another account → `EMAIL_NOW_TAKEN_MESSAGE` ("email_taken" — the
 * waiting change is closed, so My account stops showing it; the unique-index race gives the same answer).
 */
export async function confirmEmailChange(db: Db, raw: unknown, opts: AccountRequestOptions = {}): Promise<ConfirmEmailChangeResult> {
  const input = parseInput(ConfirmEmailChangeInput, raw);
  const requestId = opts.requestId ?? currentRequestId() ?? newRequestId();
  let outcome: { kind: "changed"; result: ConfirmEmailChangeResult } | { kind: "taken" };
  try {
    outcome = await withTx(
      async (tx) => {
        const now = nowIso();
        const token = await findLiveToken(tx, input.token, "email_change", now);
        if (!token?.targetEmail) throw emailChangeRefused("invalid_link");
        const user = await first(tx.select().from(users).where(and(eq(users.id, token.userId), eq(users.organisationId, token.organisationId))));
        if (!user || !user.isActive || user.anonymisedAt !== null) throw emailChangeRefused("invalid_link");
        const ctx =
          (await buildContextFromDb(tx, user.id, { cause: "user", requestId })) ??
          (await systemContext(user.organisationId, { db: tx, cause: "user", requestId }));
        const newEmail = token.targetEmail;

        if (await emailUsedByAnother(tx, newEmail, user.id)) {
          // The change can never complete now: close it (so My account stops waiting) and say so after the commit.
          await closePendingChange(tx, ctx, user.id, { reason: "taken" });
          return { kind: "taken" as const };
        }
        if (!(await markTokenUsed(tx, token.id, now))) throw emailChangeRefused("invalid_link");

        await tx
          .update(users)
          .set({ email: newEmail, version: sql`${users.version} + 1`, updatedAt: now })
          .where(and(eq(users.id, user.id), eq(users.organisationId, user.organisationId)));
        // The old address's confirmation no longer applies (and any other live verify / change link closes) …
        await clearEmailConfirmation(tx, { userId: user.id, now });
        await recordEvent(tx, ctx, {
          entityType: "user",
          entityId: user.id,
          eventType: "user.email_changed",
          action: "updated",
          previousValue: { email: user.email },
          newValue: { email: newEmail, name: user.name },
          metadata: { targetUserId: user.id, via: "link", ip: input.ip ?? null, userAgent: input.userAgent ?? null },
          visibility: "management",
        });
        // … and the link proved the new one.
        await markEmailConfirmed(tx, ctx, { userId: user.id, via: "email_change" });
        return {
          kind: "changed" as const,
          result: { userId: user.id, organisationId: user.organisationId, role: user.role, email: newEmail, previousEmail: user.email },
        };
      },
      { db },
    );
  } catch (err) {
    if (isUniqueViolation(err, "users_email_uq")) throw emailChangeRefused("email_taken");
    throw err;
  }
  if (outcome.kind === "taken") throw emailChangeRefused("email_taken");
  const { result } = outcome;
  await sendEmailChangedNotice(db, { userId: result.userId, oldEmail: result.previousEmail, newEmail: result.email, stage: "changed" }, opts.email);
  return result;
}

/* ------------------------------------------------------------------ */
/*  Password + sessions                                                */
/* ------------------------------------------------------------------ */

/**
 * POST /api/auth/set-password `{ password }` — a FIRST password for an account that has none (Google sign-ups):
 * `has_password = true`, `users.version` + 1 (sessions stay: nothing was compromised). An account with a password →
 * 422 (Change password needs the current one). There is no current password to ask for, so it needs a RECENT sign-in
 * instead (SEC-03: within RECENT_SIGN_IN_MINUTES, the cookie's `at`; else 403 `account.recent_sign_in` — whoever is
 * at an unlocked computer must not add a lasting way in). Audits `user.password_changed` (`self: true, via: "set"`);
 * after the commit "A password was added to your Proofline account".
 */
export async function setPassword(db: Db, ctx: AuthContext, raw: unknown, opts: AccountRequestOptions = {}): Promise<{ ok: true }> {
  if (!ctx.userId || ctx.isSystem) throw new UnauthorizedError();
  assertNotDemo(ctx, "password");
  const input = parseInput(SetPasswordInput, raw);
  const user = await loadSelf(db, ctx);
  // The stored hash decides (DATA-04): a `has_password` flag written by older code can say true over an unusable hash.
  if (hasUsablePassword(user)) throw rule(ALREADY_HAS_PASSWORD_MESSAGE);
  if (!signedInRecently(ctx)) throw new ForbiddenError("account.recent_sign_in", RECENT_SIGN_IN_MESSAGE);
  const passwordHash = await hashPassword(input.password);
  await withTx(
    async (tx) => {
      const now = ctx.now();
      const updated = await first(
        tx
          .update(users)
          .set({ passwordHash, hasPassword: true, version: sql`${users.version} + 1`, updatedAt: now })
          // Still the hash we read (no password set by another tab meanwhile).
          .where(and(eq(users.id, user.id), eq(users.organisationId, user.organisationId), eq(users.passwordHash, user.passwordHash)))
          .returning({ id: users.id }),
      );
      // Another tab set one a moment ago.
      if (!updated) throw rule(ALREADY_HAS_PASSWORD_MESSAGE);
      await recordEvent(tx, ctx, {
        entityType: "user",
        entityId: user.id,
        eventType: "user.password_changed",
        action: "updated",
        previousValue: { hasPassword: false },
        newValue: { hasPassword: true, name: user.name },
        metadata: { targetUserId: user.id, self: true, via: "set", ip: input.ip ?? null, userAgent: input.userAgent ?? null },
        visibility: "management",
      });
    },
    { db },
  );
  await sendPasswordChangedNotice(db, { userId: user.id, via: "set" }, opts.email);
  return { ok: true };
}

export interface SessionMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * In `tx`: bumps the person's `session_version` (every cookie issued before stops resolving — this browser's too,
 * until the caller re-issues it) and audits `auth.other_sessions_revoked` with the before / after version.
 * Returns the new version.
 */
export async function revokeOtherSessions(tx: Tx, ctx: AuthContext, meta: SessionMeta = {}): Promise<number> {
  if (!ctx.userId || ctx.isSystem) throw new UnauthorizedError();
  assertNotDemo(ctx, "sessions");
  const updated = await first(
    tx
      .update(users)
      .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
      .where(and(eq(users.id, ctx.userId), eq(users.organisationId, ctx.organisationId), eq(users.isActive, true)))
      .returning({ sessionVersion: users.sessionVersion }),
  );
  if (!updated) throw new UnauthorizedError();
  await recordEvent(tx, ctx, {
    entityType: "auth",
    entityId: ctx.userId,
    eventType: "auth.other_sessions_revoked",
    action: "revoked",
    previousValue: { sessionVersion: updated.sessionVersion - 1 },
    newValue: { sessionVersion: updated.sessionVersion },
    metadata: { targetUserId: ctx.userId, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null },
    visibility: "management",
  });
  return updated.sessionVersion;
}

/**
 * POST /api/auth/sign-out-others — "Log out of other devices": every other browser / phone is logged out, THIS
 * one stays signed in (its cookie is re-issued at the new session version). Route handlers / server actions only.
 */
export async function signOutOtherDevices(db: Db, ctx: AuthContext, meta: SessionMeta = {}): Promise<{ ok: true }> {
  if (!ctx.userId || ctx.isSystem) throw new UnauthorizedError();
  assertNotDemo(ctx, "sessions");
  const sessionVersion = await withTx((tx) => revokeOtherSessions(tx, ctx, meta), { db });
  // Not a new sign-in: the cookie keeps its sign-in time (an old one stays "not recent" — SEC-03).
  await issueSessionCookie({ id: ctx.userId, role: ctx.role, sessionVersion, signedInAt: ctx.signedInAt ?? null });
  return { ok: true };
}
