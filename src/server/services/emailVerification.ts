/**
 * Email confirmation ("Confirm your email") — AREA verify (docs/ACCOUNTS-PLAN.md §4 "AREA verify",
 * docs/ACCOUNTS.md §3).
 *
 *   sendEmailConfirmation(db, { userId, reason, req?, requestId? })   issue an email_verify link + email it
 *   resendEmailConfirmation(db, ctx, { req?, requestId? })             signed-in "Send again" (5 / hour / person)
 *   confirmEmail(db, raw)                                              public: the button on /verify-email
 *
 * Rules:
 * - a link is for the address it was sent to (`auth_tokens.target_email`): it stops working once the email changes
 *   (`clearEmailConfirmation` also consumes it), and issuing a new one supersedes the older ones
 * - the link page confirms on a BUTTON press (POST), never on GET — mail scanners open links — and never signs in
 * - without a mail provider the feature is invisible in production (nothing issued, nothing shown); outside
 *   production a link IS issued and handed back as the dev-only `devLink`, so local development and the e2e suite can
 *   walk the whole flow (the DevOnlyLink pattern of the reset / invite flows)
 * - a demo studio never gets a link (no email is ever sent there)
 * - the plain token is returned once to `sendAccountEmail` (and, in development only, as `devLink`); it is never
 *   stored, logged or audited
 */
import { and, eq } from "drizzle-orm";
import { first, type Db } from "@/db/index";
import { authTokens, organisationSettings, organisations, users } from "@/db/schema";
import type { AuthContext } from "@/lib/types";
import { VerifyEmailInput } from "@/lib/validation/auth";
import { recordEvent } from "@/server/audit";
import { enforceRateLimit, userKey } from "@/server/auth/db-rate-limit";
import { markEmailConfirmed } from "@/server/auth/email-confirmation";
import { buildContextFromDb, systemContext } from "@/server/auth/session";
import { hashToken, issueToken, markTokenUsed } from "@/server/auth/tokens";
import { nowIso } from "@/server/clock";
import { accountEmailBlock, devLinksAllowed, sendAccountEmail, type AccountEmailNotSentReason, type AccountEmailOptions } from "@/server/email/account";
import { confirmEmailEmail } from "@/server/email/templates";
import { RuleViolationError, UnauthorizedError, ValidationError } from "@/server/errors";
import { verifyEmailUrl } from "@/server/origin";
import { currentRequestId, newRequestId } from "@/server/request-scope";
import { withTx } from "./_shared";

export interface EmailConfirmationSendResult {
  /** True when the confirm link was emailed. */
  sent: boolean;
  /** Why not (null when sent): the account-email reasons, or "already_confirmed". */
  reason: AccountEmailNotSentReason | "already_confirmed" | null;
  /** Development only (no mail provider): the link to show instead. Never in production. */
  devLink?: string;
  /** When the issued link stops working (absent when none was issued). */
  expiresAt?: string;
}

export interface SendEmailConfirmationInput {
  userId: string;
  /**
   * "signup" right after "Create your studio"; "invite" right after accepting an invite that did not prove the
   * address (SEC-05); "resend" from the banner / My account.
   */
  reason: "signup" | "invite" | "resend";
  req?: Request | null;
  requestId?: string;
}

/** Test seams: the environment (configured / production) and the mail transport. */
export type EmailConfirmationOptions = AccountEmailOptions;

/** The one message of a confirm link that does not work (any reason): plain words, no account oracle. */
export const CONFIRM_LINK_INVALID_MESSAGE = "This confirmation link is no longer valid";

/** "Send again" for an address that is already confirmed (422). */
export const EMAIL_ALREADY_CONFIRMED_MESSAGE = "Your email is already confirmed";

/**
 * Why a confirm link did not work, in `details.reason` of the 400 so the page can say the right thing to the person
 * holding the link (only they can learn it — the token is 256 random bits):
 *   invalid            unknown / mangled link, the account is gone or deactivated, or the email changed since
 *   expired            older than 24 hours and the address is still unconfirmed
 *   used               already used or replaced by a newer link, and the address is still unconfirmed
 *   already_confirmed  the address this link was for is confirmed (by this link or any other way)
 */
export const CONFIRM_LINK_FAILURES = ["invalid", "expired", "used", "already_confirmed"] as const;
export type ConfirmLinkFailure = (typeof CONFIRM_LINK_FAILURES)[number];

function deadLink(reason: ConfirmLinkFailure): ValidationError {
  return new ValidationError(CONFIRM_LINK_INVALID_MESSAGE, { formErrors: [CONFIRM_LINK_INVALID_MESSAGE], fieldErrors: {}, reason });
}

function alreadyConfirmed(): RuleViolationError {
  return new RuleViolationError(EMAIL_ALREADY_CONFIRMED_MESSAGE, { formErrors: [EMAIL_ALREADY_CONFIRMED_MESSAGE], fieldErrors: {} });
}

const normalise = (email: string) => email.trim().toLowerCase();

/** A log line never carries a link's token (nor its stored hash), whatever the error message echoed. */
export function redactLinks(text: string): string {
  return text.replace(/token=[A-Za-z0-9_%-]+/g, "token=[redacted]").replace(/\b[a-f0-9]{64}\b/g, "[redacted]");
}

interface ConfirmationTarget {
  id: string;
  organisationId: string;
  email: string;
  name: string;
  isActive: boolean;
  anonymisedAt: string | null;
  emailVerifiedAt: string | null;
  studioName: string;
  timezone: string | null;
}

async function loadTarget(db: Db, userId: string): Promise<ConfirmationTarget | undefined> {
  return first(
    db
      .select({
        id: users.id,
        organisationId: users.organisationId,
        email: users.email,
        name: users.name,
        isActive: users.isActive,
        anonymisedAt: users.anonymisedAt,
        emailVerifiedAt: users.emailVerifiedAt,
        studioName: organisations.name,
        timezone: organisationSettings.timezone,
      })
      .from(users)
      .innerJoin(organisations, eq(organisations.id, users.organisationId))
      .leftJoin(organisationSettings, eq(organisationSettings.organisationId, users.organisationId))
      .where(eq(users.id, userId)),
  );
}

async function issueAndSend(db: Db, input: SendEmailConfirmationInput, opts: EmailConfirmationOptions): Promise<EmailConfirmationSendResult> {
  const env = opts.env ?? process.env;
  const user = await loadTarget(db, input.userId);
  if (!user || !user.isActive || user.anonymisedAt !== null) return { sent: false, reason: "failed" };
  if (user.emailVerifiedAt !== null) return { sent: false, reason: "already_confirmed" };

  const block = await accountEmailBlock(db, { userId: user.id }, { env });
  if (block === "demo") return { sent: false, reason: "demo" };
  // No mail provider in production: the feature is invisible — nothing is issued. (Development: issue the link and
  // hand it back as the dev-only link, so the flow can be followed without email.)
  if (block === "not_configured" && !devLinksAllowed(env)) return { sent: false, reason: "not_configured" };

  const requestId = input.requestId ?? currentRequestId() ?? newRequestId();
  const issued = await withTx(
    async (tx) => {
      const now = nowIso();
      // Re-read inside the transaction: the address the link is for, and whether it got confirmed meanwhile.
      const current = await first(tx.select({ email: users.email, emailVerifiedAt: users.emailVerifiedAt }).from(users).where(eq(users.id, user.id)));
      if (!current || current.emailVerifiedAt !== null) return null;
      const token = await issueToken(tx, {
        organisationId: user.organisationId,
        userId: user.id,
        kind: "email_verify",
        createdByUserId: input.reason === "resend" ? user.id : null,
        now,
        targetEmail: current.email,
      });
      const ctx =
        (await buildContextFromDb(tx, user.id, { requestId, cause: input.reason === "signup" ? "signup" : "user" })) ??
        (await systemContext(user.organisationId, { db: tx, cause: "user", requestId }));
      await recordEvent(tx, ctx, {
        entityType: "user",
        entityId: user.id,
        eventType: "user.email_confirmation_sent",
        action: "requested",
        previousValue: null,
        newValue: { email: current.email, name: user.name, expiresAt: token.expiresAt },
        // `sent`: it goes out by email (a provider is set up); false = development without email (dev-only link).
        metadata: { targetUserId: user.id, reason: input.reason, superseded: token.superseded, sent: block === null },
        visibility: "management",
      });
      return { token: token.token, expiresAt: token.expiresAt, email: current.email };
    },
    { db },
  );
  if (!issued) return { sent: false, reason: "already_confirmed" };

  // After COMMIT: the link exists before anyone can open it. sendAccountEmail never throws for a mail problem.
  const url = verifyEmailUrl(issued.token, input.req);
  const content = confirmEmailEmail({
    name: user.name,
    confirmUrl: url,
    expiresAt: issued.expiresAt,
    timezone: user.timezone ?? undefined,
    studioName: user.studioName,
  });
  const result = await sendAccountEmail(db, { userId: user.id, to: issued.email, content, link: url }, { env, send: opts.send });
  return {
    sent: result.sent,
    reason: result.reason,
    ...(result.devLink ? { devLink: result.devLink } : {}),
    expiresAt: issued.expiresAt,
  };
}

/**
 * Issues a fresh `email_verify` link for the user's CURRENT address (older ones are superseded), audits
 * `user.email_confirmation_sent` and, after commit, emails "Confirm your email" through `sendAccountEmail`.
 * Issues NOTHING for a demo studio, an already confirmed address, or (in production) when email is not configured.
 *
 * For `reason: "signup"` / "invite" it never throws (the account already exists and the person is signed in: a hiccup
 * here must not turn "Create your studio" or joining into an error) — a failure comes back as `{ sent: false, reason:
 * "failed" }` and the person can use "Send again". For "resend" errors propagate to the caller.
 */
export async function sendEmailConfirmation(db: Db, input: SendEmailConfirmationInput, opts: EmailConfirmationOptions = {}): Promise<EmailConfirmationSendResult> {
  if (input.reason === "resend") return issueAndSend(db, input, opts);
  try {
    return await issueAndSend(db, input, opts);
  } catch (err) {
    console.warn(`[emailVerification] the ${input.reason} confirmation link was not issued`, redactLinks(err instanceof Error ? err.message : String(err)));
    return { sent: false, reason: "failed" };
  }
}

/**
 * "Send again" (the banner, My account, the link page): any signed-in person, for their own address.
 * Demo studio → `{ sent: false, reason: "demo" }` (nothing issued). Already confirmed → 422. Otherwise counted by the
 * `verifyResend` limiter (5 / hour / person → 429 + retry-after) and `sendEmailConfirmation(reason "resend")`.
 */
export async function resendEmailConfirmation(
  db: Db,
  ctx: AuthContext,
  input: { req?: Request | null; requestId?: string } = {},
  opts: EmailConfirmationOptions = {},
): Promise<EmailConfirmationSendResult> {
  if (!ctx.userId || ctx.isSystem) throw new UnauthorizedError();
  if (ctx.isDemo) return { sent: false, reason: "demo" };
  const me = await first(
    db
      .select({ emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(and(eq(users.id, ctx.userId), eq(users.organisationId, ctx.organisationId))),
  );
  if (!me) throw new UnauthorizedError();
  if (me.emailVerifiedAt !== null) throw alreadyConfirmed();
  await enforceRateLimit(db, "verifyResend", userKey(ctx.userId), Date.parse(ctx.now()));
  const result = await sendEmailConfirmation(db, { userId: ctx.userId, reason: "resend", req: input.req, requestId: input.requestId ?? ctx.requestId }, opts);
  if (result.reason === "already_confirmed") throw alreadyConfirmed();
  return result;
}

export interface ConfirmEmailResult {
  /** The address that is now confirmed. */
  email: string;
  userId: string;
  /** True when it was already confirmed before this press (the link is used up either way). */
  alreadyConfirmed: boolean;
}

/**
 * POST /api/auth/verify-email `{ token }` (public). A live `email_verify` link whose `target_email` is still the
 * account's address, for an active, not anonymised account → the link is used up and the email confirmed
 * (`markEmailConfirmed`, via "link"; audited as the person themselves, or as the system when their own context
 * cannot be built — e.g. a client whose portal was switched off). Anything else → 400 `CONFIRM_LINK_INVALID_MESSAGE`
 * with `details.reason` (`ConfirmLinkFailure`). Never signs anyone in.
 */
export async function confirmEmail(db: Db, raw: unknown, opts: { requestId?: string } = {}): Promise<ConfirmEmailResult> {
  const parsed = VerifyEmailInput.safeParse(raw);
  if (!parsed.success) throw deadLink("invalid");
  const requestId = opts.requestId ?? currentRequestId() ?? newRequestId();
  return withTx(
    async (tx) => {
      const now = nowIso();
      const row = await first(
        tx
          .select()
          .from(authTokens)
          .where(and(eq(authTokens.tokenHash, hashToken(parsed.data.token)), eq(authTokens.kind, "email_verify"))),
      );
      if (!row) throw deadLink("invalid");
      const user = await first(tx.select().from(users).where(and(eq(users.id, row.userId), eq(users.organisationId, row.organisationId))));
      if (!user || !user.isActive || user.anonymisedAt !== null) throw deadLink("invalid");
      // A link only ever confirms the address it was sent to.
      if (row.targetEmail === null || row.targetEmail !== normalise(user.email)) throw deadLink("invalid");

      const live = row.usedAt === null && row.expiresAt > now;
      if (!live) {
        if (user.emailVerifiedAt !== null) throw deadLink("already_confirmed");
        throw deadLink(row.usedAt !== null ? "used" : "expired");
      }
      const ctx =
        (await buildContextFromDb(tx, user.id, { requestId, cause: "user" })) ??
        (await systemContext(user.organisationId, { db: tx, cause: "user", requestId }));
      // Fill-once: a second press racing this one loses here.
      if (!(await markTokenUsed(tx, row.id, now))) throw deadLink(user.emailVerifiedAt !== null ? "already_confirmed" : "used");
      const changed = await markEmailConfirmed(tx, ctx, { userId: user.id, via: "link" });
      return { email: user.email, userId: user.id, alreadyConfirmed: !changed };
    },
    { db },
  );
}
