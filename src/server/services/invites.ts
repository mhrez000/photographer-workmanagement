/**
 * Invite links (front door). An invited person (editor, photographer, client portal user) has no usable
 * password until they open their link and choose one.
 *
 *   createInvite / resendInvite   admin (`user.invite`): a fresh 7-day token for a pending user; older live
 *                                 tokens are superseded in the same transaction; audited `user.invite_sent`
 *   revokeInvite                  admin: every live token consumed; audited `user.invite_revoked`
 *                                 (create / resend / revoke are refused in the demo studio: 403 `demo.invite`)
 *   lookupInvite                  public: what the accept page shows ({ valid, studioName, inviterName, role, … })
 *   acceptInvite                  public: sets the password + `accepted_at` (+ name), bumps `session_version`,
 *                                 marks the token used, audits `user.accepted_invite` as the person themself
 *   completeInviteAcceptance      the ONE accept core (link + password, or Google): accounts / AREA google reuse it;
 *                                 marks the email confirmed only when the caller says so (SEC-05: the inviter always
 *                                 holds a copy of the link, so opening it proves nothing on its own — see
 *                                 `inviteVouchesForAddress`); refused in a demo studio (DATA-05)
 *   findLiveInvite                the live invite behind a plain token (public lookups, Google `intent=invite`)
 *   deliverInvite                 builds the link (APP_URL) and emails it through `sendAccountEmail` — never from a
 *                                 demo studio, never on behalf of an inviter whose own email is unconfirmed
 *
 * Every failure of a public call is the ONE generic 400 (`INVITE_INVALID_MESSAGE`): unknown, expired, used,
 * revoked, deactivated user, closed portal — nothing distinguishes them. The plain token is never stored,
 * logged or audited (only its sha256 is at rest).
 */
import { and, eq } from "drizzle-orm";
import { first, getDb, type Db, type DbLike, type Tx } from "@/db/index";
import { authTokens, organisationSettings, organisations, users } from "@/db/schema";
import { PERSONA_LABELS, personaMayEver, personaOfUser, type Persona, type Role } from "@/lib/constants";
import type { AuthContext, User } from "@/lib/types";
import { AcceptInviteInput, InviteTargetInput, InviteTokenInput } from "@/lib/validation/auth";
import { recordEvent } from "@/server/audit";
import { hashPassword, isUsablePasswordHash } from "@/server/auth/password";
import { assertCan, personaOf } from "@/server/auth/permissions";
import { assertNotDemo } from "@/server/auth/demo";
import { markEmailConfirmed } from "@/server/auth/email-confirmation";
import { buildContextFromDb } from "@/server/auth/session";
import { issueSessionCookie } from "@/server/auth/sign-in";
import { consumeLiveTokens, findLiveToken, hashToken, issueToken, liveTokensFor, markTokenUsed } from "@/server/auth/tokens";
import { nowIso } from "@/server/clock";
import { emailConfigured } from "@/server/email";
import { sendAccountEmail, type AccountEmailNotSentReason } from "@/server/email/account";
import { inviteEmail } from "@/server/email/templates";
import { ForbiddenError, RuleViolationError, ValidationError } from "@/server/errors";
import { inviteUrl } from "@/server/origin";
import { currentRequestId, newRequestId } from "@/server/request-scope";
import { loadUserInOrg, parseInput, withTx } from "./_shared";
import { sendEmailConfirmation } from "./emailVerification";
import { primaryOwnerIdOf, userPermissionRef } from "./users";

export const INVITE_INVALID_MESSAGE = "This invite link is no longer valid";

export interface InviteToken {
  /** The plain token: show / email it once. */
  token: string;
  expiresAt: string;
}

function invalidInvite(): ValidationError {
  return new ValidationError(INVITE_INVALID_MESSAGE, { formErrors: [INVITE_INVALID_MESSAGE], fieldErrors: {} });
}

/** 422: well-formed input that breaks an invite rule (already joined, deactivated, anonymised). */
function inviteRule(message: string): RuleViolationError {
  return new RuleViolationError(message, { formErrors: [message], fieldErrors: {} });
}

function requireAdminHuman(ctx: AuthContext): string {
  if (!ctx.userId || ctx.isSystem || !ctx.isActive || !personaMayEver(personaOf(ctx), "user.invite")) throw new ForbiddenError("user.invite");
  // Accounts: invites (new links, resends, revokes) are off in the demo studio (403 `demo.invite`, plain copy).
  assertNotDemo(ctx, "invite");
  return ctx.userId;
}

/** A pending (never accepted) active user of the actor's organisation, after the `user.invite` scope check. */
async function loadPendingTarget(tx: Tx, ctx: AuthContext, userId: string): Promise<User> {
  const target = await loadUserInOrg(tx, ctx, userId);
  assertCan(ctx, "user.invite", userPermissionRef(target, { primaryOwnerId: await primaryOwnerIdOf(tx, ctx.organisationId), nextRole: target.role }));
  if (target.anonymisedAt) throw inviteRule("This user has been anonymised and can no longer be invited");
  if (!target.isActive) throw inviteRule(`${target.name} is deactivated. Reactivate them before sending an invite.`);
  if (target.acceptedAt) throw inviteRule(`${target.name} has already joined; there is nothing to invite them to.`);
  return target;
}

/* ------------------------------------------------------------------ */
/*  Admin side                                                         */
/* ------------------------------------------------------------------ */

/**
 * Issues an invite token for a pending user (admins; `user.invite`). Any older live invite tokens are
 * superseded. Stamps `users.invited_at`. Audits `user.invite_sent` (`metadata.resend` when re-sent).
 */
export async function createInvite(tx: Tx, ctx: AuthContext, input: unknown, opts: { resend?: boolean } = {}): Promise<InviteToken> {
  const actorId = requireAdminHuman(ctx);
  const data = parseInput(InviteTargetInput, input);
  const target = await loadPendingTarget(tx, ctx, data.userId);
  const now = ctx.now();
  const issued = await issueToken(tx, { organisationId: ctx.organisationId, userId: target.id, kind: "invite", createdByUserId: actorId, now });
  await tx.update(users).set({ invitedAt: now, updatedAt: now }).where(eq(users.id, target.id));
  await recordEvent(tx, ctx, {
    entityType: "user",
    entityId: target.id,
    eventType: "user.invite_sent",
    action: "invited",
    previousValue: null,
    newValue: { name: target.name, email: target.email, role: target.role, expiresAt: issued.expiresAt },
    metadata: { targetUserId: target.id, targetName: target.name, resend: opts.resend ?? false, superseded: issued.superseded, method: "link" },
  });
  return { token: issued.token, expiresAt: issued.expiresAt };
}

/** A new link for someone who lost / let expire the first one; the old links stop working. */
export async function resendInvite(tx: Tx, ctx: AuthContext, input: unknown): Promise<InviteToken> {
  return createInvite(tx, ctx, input, { resend: true });
}

export interface RevokeInviteResult {
  userId: string;
  /** Live tokens consumed (0 when none was pending — still a success). */
  revoked: number;
}

/** Consumes every live invite token of a pending user (admins). The account stays, without a way in. */
export async function revokeInvite(tx: Tx, ctx: AuthContext, input: unknown): Promise<RevokeInviteResult> {
  requireAdminHuman(ctx);
  const data = parseInput(InviteTargetInput, input);
  const target = await loadPendingTarget(tx, ctx, data.userId);
  const now = ctx.now();
  const revoked = await consumeLiveTokens(tx, target.id, "invite", now);
  await recordEvent(tx, ctx, {
    entityType: "user",
    entityId: target.id,
    eventType: "user.invite_revoked",
    action: "revoked",
    previousValue: null,
    newValue: { name: target.name, email: target.email, role: target.role },
    metadata: { targetUserId: target.id, targetName: target.name, revoked },
  });
  return { userId: target.id, revoked };
}

/** Whether a pending user currently has a live invite link (People page: "Invite pending · expires …"). */
export async function pendingInviteFor(db: DbLike, userId: string, now: string = nowIso()): Promise<{ expiresAt: string } | null> {
  const live = await liveTokensFor(db, userId, "invite", now);
  const latest = live[live.length - 1];
  return latest ? { expiresAt: latest.expiresAt } : null;
}

/* ------------------------------------------------------------------ */
/*  Delivery                                                           */
/* ------------------------------------------------------------------ */

export interface InviteDelivery {
  inviteUrl: string;
  /** True when the link was emailed (provider configured and accepted it); false → show the copyable link. */
  emailed: boolean;
  expiresAt: string;
  /**
   * Why it was not emailed (null when it was): "not_configured" (no provider), "unconfirmed_sender" (the inviter
   * has not confirmed their own email yet — anti-abuse), "demo" (never: invites are off there), "failed".
   */
  notSentReason: AccountEmailNotSentReason | null;
}

/**
 * Builds the invite link (APP_URL, else the request origin) and emails it to the invitee through
 * `sendAccountEmail` (suppressed for a demo studio and while the inviter's own email is unconfirmed). Call it AFTER
 * the transaction that issued the token committed. Never throws for a mail failure. The owner always gets the
 * link back to copy (`inviteUrl`), in production too — that is the invite flow's own design.
 */
export async function deliverInvite(
  db: DbLike,
  input: { token: string; expiresAt: string; userId: string; inviterUserId: string | null; req?: Request | null },
): Promise<InviteDelivery> {
  const url = inviteUrl(input.token, input.req);
  const target = await first(
    db
      .select({ email: users.email, role: users.role, isAdmin: users.isAdmin, organisationId: users.organisationId, studio: organisations.name, timezone: organisationSettings.timezone })
      .from(users)
      .innerJoin(organisations, eq(organisations.id, users.organisationId))
      .innerJoin(organisationSettings, eq(organisationSettings.organisationId, users.organisationId))
      .where(eq(users.id, input.userId)),
  );
  if (!target) return { inviteUrl: url, emailed: false, expiresAt: input.expiresAt, notSentReason: "failed" };
  const inviter = input.inviterUserId ? await first(db.select({ name: users.name }).from(users).where(eq(users.id, input.inviterUserId))) : undefined;
  const content = inviteEmail({
    studioName: target.studio,
    inviterName: inviter?.name ?? target.studio,
    persona: personaOfUser({ role: target.role, isAdmin: target.isAdmin }),
    inviteUrl: url,
    expiresAt: input.expiresAt,
    timezone: target.timezone,
  });
  const sent = await sendAccountEmail(db, { userId: input.userId, to: target.email, content, senderUserId: input.inviterUserId });
  return { inviteUrl: url, emailed: sent.sent, expiresAt: input.expiresAt, notSentReason: sent.reason };
}

/* ------------------------------------------------------------------ */
/*  Public side                                                        */
/* ------------------------------------------------------------------ */

export type InviteLookup =
  | { valid: true; studioName: string; inviterName: string | null; role: Role; persona: Persona; personaLabel: string; email: string; name: string; expiresAt: string }
  | { valid: false };

export interface LiveInvite {
  tokenId: string;
  /** The still-pending (never accepted), active, not anonymised invitee. */
  user: User;
  studioName: string;
  inviterName: string | null;
  expiresAt: string;
}

/**
 * The live invite behind a plain token (already cleaned), with its still-pending, active user; null for anything
 * else (unknown / expired / used / revoked / accepted / deactivated — indistinguishable on purpose).
 */
export async function findLiveInvite(db: DbLike, token: string, now: string): Promise<LiveInvite | null> {
  const row = await findLiveToken(db, token, "invite", now);
  if (!row) return null;
  const user = await first(db.select().from(users).where(eq(users.id, row.userId)));
  if (!user || !user.isActive || user.anonymisedAt || user.acceptedAt) return null;
  const org = await first(db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, user.organisationId)));
  if (!org) return null;
  const inviter = row.createdByUserId ? await first(db.select({ name: users.name }).from(users).where(eq(users.id, row.createdByUserId))) : undefined;
  return { tokenId: row.id, user, studioName: org.name, inviterName: inviter?.name ?? null, expiresAt: row.expiresAt };
}

/**
 * The invite page for a link that no longer works, when somebody IS signed in on this browser (UX-06): was this invite
 * theirs, i.e. have they already joined with it? Then the page says "You've already joined <studio>" instead of the
 * dead-link card. Only ever answered for the signed-in person's OWN link (`viewerUserId`), so it tells nobody anything
 * new; null for anything else (unknown token, someone else's invite, a different studio).
 */
export async function joinedWithInvite(db: DbLike, raw: unknown, viewerUserId: string): Promise<{ studioName: string } | null> {
  const parsed = InviteTokenInput.safeParse(raw);
  if (!parsed.success) return null;
  const row = await first(
    db
      .select({ userId: authTokens.userId, acceptedAt: users.acceptedAt, studioName: organisations.name })
      .from(authTokens)
      .innerJoin(users, eq(users.id, authTokens.userId))
      .innerJoin(organisations, eq(organisations.id, users.organisationId))
      .where(and(eq(authTokens.tokenHash, hashToken(parsed.data.token)), eq(authTokens.kind, "invite"))),
  );
  if (!row || row.userId !== viewerUserId || row.acceptedAt === null) return null;
  return { studioName: row.studioName };
}

/** GET /api/auth/invite/:token — what the accept page shows. Unknown / expired / used → `{ valid: false }`. */
export async function lookupInvite(db: DbLike, raw: unknown): Promise<InviteLookup> {
  const parsed = InviteTokenInput.safeParse(raw);
  if (!parsed.success) return { valid: false };
  const live = await findLiveInvite(db, parsed.data.token, nowIso());
  if (!live) return { valid: false };
  const persona = personaOfUser(live.user);
  return {
    valid: true,
    studioName: live.studioName,
    inviterName: live.inviterName,
    role: live.user.role,
    persona,
    personaLabel: PERSONA_LABELS[persona],
    email: live.user.email,
    name: live.user.name,
    expiresAt: live.expiresAt,
  };
}

export interface AcceptInviteResult {
  userId: string;
  organisationId: string;
  name: string;
  email: string;
  role: Role;
  sessionVersion: number;
}

export interface CompleteInviteInput {
  /** The pending invitee (from `findLiveInvite`, read inside this transaction). */
  user: User;
  /** The invite token being used (marked used, fill-once); null → every live invite token of the user is consumed. */
  tokenId: string | null;
  now: string;
  /** How they accepted: "link" (chose a password) or "google" (AREA google: Google proved who they are). */
  via: "link" | "google";
  /** bcrypt hash of the chosen password; null (Google) keeps the unusable hash and `has_password = false`. */
  passwordHash: string | null;
  /** A corrected name (else the invited name). */
  name?: string;
  /**
   * Mark the email confirmed. Link: only when `inviteVouchesForAddress` (a confirmed inviter, and the invite could be
   * emailed); Google: only when Google is the authority for exactly the invited address.
   */
  emailConfirmed: boolean;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string;
}

/**
 * The ONE invite-acceptance core, inside the caller's transaction. Refuses (generic 400) when the person has no
 * context (a client whose portal is closed), belongs to the demo studio (DATA-05: invites are off there, and a link a
 * visitor made before the studio became the demo must not open a real account in it) or the token was consumed
 * meanwhile. Sets `accepted_at` and `last_login_at` (accepting signs the person in), the name, the password
 * (+ `has_password`) when given — without one, `has_password` follows the stored hash (DATA-04) — bumps
 * `session_version` and `version`, marks the email confirmed when asked (`markEmailConfirmed`, via "invite"),
 * audits `user.accepted_invite` (`metadata.via`) as the person themself. The caller issues the cookie.
 */
export async function completeInviteAcceptance(tx: Tx, input: CompleteInviteInput): Promise<AcceptInviteResult> {
  const { user, now } = input;
  // A client whose portal is closed (or archived) has no context → the same generic answer.
  const ctx = await buildContextFromDb(tx, user.id, { cause: "user", requestId: input.requestId ?? currentRequestId() ?? newRequestId() });
  if (!ctx || ctx.isDemo) throw invalidInvite();
  if (input.tokenId !== null) {
    if (!(await markTokenUsed(tx, input.tokenId, now))) throw invalidInvite();
    // Any other live invite link of theirs stops working too (normally there is only the one).
    await consumeLiveTokens(tx, user.id, "invite", now);
  } else {
    await consumeLiveTokens(tx, user.id, "invite", now);
  }
  const nextSession = user.sessionVersion + 1;
  const name = input.name ?? user.name;
  await tx
    .update(users)
    // Accepting signs the person in, so People's "Last signed in" reads now rather than "Never".
    .set({
      ...(input.passwordHash !== null ? { passwordHash: input.passwordHash, hasPassword: true } : { hasPassword: isUsablePasswordHash(user.passwordHash) }),
      acceptedAt: now,
      lastLoginAt: now,
      name,
      sessionVersion: nextSession,
      updatedAt: now,
      version: user.version + 1,
    })
    .where(eq(users.id, user.id));
  await recordEvent(tx, ctx, {
    entityType: "user",
    entityId: user.id,
    eventType: "user.accepted_invite",
    action: "accepted",
    previousValue: { acceptedAt: null, name: user.name },
    newValue: { acceptedAt: now, name },
    metadata: { targetUserId: user.id, ip: input.ip ?? null, userAgent: input.userAgent ?? null, nameChanged: name !== user.name, via: input.via },
    visibility: "management",
  });
  if (input.emailConfirmed) await markEmailConfirmed(tx, ctx, { userId: user.id, via: "invite" });
  return { userId: user.id, organisationId: user.organisationId, name, email: user.email, role: user.role, sessionVersion: nextSession };
}

/**
 * Does opening this invite link count as proving the invitee's address? (SEC-05) The inviter can always copy the link,
 * so on its own it proves nothing. It counts only when the person who made the link has CONFIRMED their own email
 * (they are accountable for where the link went — and could send invite emails themselves anyway) AND email is set up
 * (so the link was emailed to that address). An unconfirmed owner can therefore never mint "confirmed" accounts to get
 * around the rule that unconfirmed people's invites are not emailed.
 */
export async function inviteVouchesForAddress(db: DbLike, tokenId: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<boolean> {
  if (!emailConfigured(env)) return false;
  const row = await first(
    db
      .select({ verifiedAt: users.emailVerifiedAt })
      .from(authTokens)
      .innerJoin(users, eq(users.id, authTokens.createdByUserId))
      .where(eq(authTokens.id, tokenId)),
  );
  return Boolean(row?.verifiedAt);
}

/**
 * POST /api/auth/invite/:token/accept `{ password, name? }` (public). Validates the link, sets the password
 * and `accepted_at` (+ the name when given), bumps `session_version`, marks the token used, confirms the email only
 * when `inviteVouchesForAddress`, audits `user.accepted_invite` as the person themself. Any invalid link → the one
 * generic 400.
 */
export async function acceptInvite(
  db: Db,
  raw: unknown,
  opts: { requestId?: string; env?: Readonly<Record<string, string | undefined>> } = {},
): Promise<AcceptInviteResult> {
  const input = parseInput(AcceptInviteInput, raw);
  const passwordHash = await hashPassword(input.password);
  return withTx(
    async (tx) => {
      const now = nowIso();
      const live = await findLiveInvite(tx, input.token, now);
      if (!live) throw invalidInvite();
      return completeInviteAcceptance(tx, {
        user: live.user,
        tokenId: live.tokenId,
        now,
        via: "link",
        passwordHash,
        name: input.name,
        emailConfirmed: await inviteVouchesForAddress(tx, live.tokenId, opts.env),
        ip: input.ip,
        userAgent: input.userAgent,
        requestId: opts.requestId,
      });
    },
    { db },
  );
}

/**
 * Accept + the session cookie (route handlers; this browser is remembered for the address) + "Confirm your email"
 * when the acceptance did not already confirm it (`sendEmailConfirmation` reason "invite": never throws, issues nothing
 * in production without email, nothing for an address that is already confirmed).
 */
export async function acceptInviteAndSignIn(raw: unknown, opts: { requestId?: string; db?: Db; req?: Request | null } = {}): Promise<AcceptInviteResult> {
  const db = opts.db ?? getDb();
  const result = await acceptInvite(db, raw, opts);
  await issueSessionCookie({ id: result.userId, role: result.role, sessionVersion: result.sessionVersion, email: result.email });
  await sendEmailConfirmation(db, { userId: result.userId, reason: "invite", req: opts.req, requestId: opts.requestId });
  return result;
}
