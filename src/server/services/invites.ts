/**
 * Invite links (front door). An invited person (editor, photographer, client portal user) has no usable
 * password until they open their link and choose one.
 *
 *   createInvite / resendInvite   admin (`user.invite`): a fresh 7-day token for a pending user; older live
 *                                 tokens are superseded in the same transaction; audited `user.invite_sent`
 *   revokeInvite                  admin: every live token consumed; audited `user.invite_revoked`
 *   lookupInvite                  public: what the accept page shows ({ valid, studioName, inviterName, role, … })
 *   acceptInvite                  public: sets the password + `accepted_at` (+ name), bumps `session_version`,
 *                                 marks the token used, audits `user.accepted_invite` as the person themself
 *   deliverInvite                 builds the link (APP_URL) and emails it when email is configured
 *
 * Every failure of a public call is the ONE generic 400 (`INVITE_INVALID_MESSAGE`): unknown, expired, used,
 * revoked, deactivated user, closed portal — nothing distinguishes them. The plain token is never stored,
 * logged or audited (only its sha256 is at rest).
 */
import { eq } from "drizzle-orm";
import { first, getDb, type Db, type DbLike, type Tx } from "@/db/index";
import { organisationSettings, organisations, users } from "@/db/schema";
import { PERSONA_LABELS, personaMayEver, personaOfUser, type Persona, type Role } from "@/lib/constants";
import type { AuthContext, User } from "@/lib/types";
import { AcceptInviteInput, InviteTargetInput, InviteTokenInput } from "@/lib/validation/auth";
import { recordEvent } from "@/server/audit";
import { hashPassword } from "@/server/auth/password";
import { assertCan, personaOf } from "@/server/auth/permissions";
import { buildContextFromDb, createSession, sessionKindForRole } from "@/server/auth/session";
import { consumeLiveTokens, findLiveToken, issueToken, liveTokensFor, markTokenUsed } from "@/server/auth/tokens";
import { nowIso } from "@/server/clock";
import { sendEmail } from "@/server/email";
import { inviteEmail } from "@/server/email/templates";
import { ForbiddenError, RuleViolationError, ValidationError } from "@/server/errors";
import { inviteUrl } from "@/server/origin";
import { currentRequestId, newRequestId } from "@/server/request-scope";
import { loadUserInOrg, parseInput, withTx } from "./_shared";
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
}

/**
 * Builds the invite link (APP_URL, else the request origin) and emails it to the invitee when email is
 * configured. Call it AFTER the transaction that issued the token committed. Never throws for a mail failure.
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
  if (!target) return { inviteUrl: url, emailed: false, expiresAt: input.expiresAt };
  const inviter = input.inviterUserId ? await first(db.select({ name: users.name }).from(users).where(eq(users.id, input.inviterUserId))) : undefined;
  const content = inviteEmail({
    studioName: target.studio,
    inviterName: inviter?.name ?? target.studio,
    persona: personaOfUser({ role: target.role, isAdmin: target.isAdmin }),
    inviteUrl: url,
    expiresAt: input.expiresAt,
    timezone: target.timezone,
  });
  const sent = await sendEmail({ to: target.email, ...content });
  return { inviteUrl: url, emailed: sent.ok, expiresAt: input.expiresAt };
}

/* ------------------------------------------------------------------ */
/*  Public side                                                        */
/* ------------------------------------------------------------------ */

export type InviteLookup =
  | { valid: true; studioName: string; inviterName: string | null; role: Role; persona: Persona; personaLabel: string; email: string; name: string; expiresAt: string }
  | { valid: false };

interface LiveInvite {
  tokenId: string;
  user: User;
  studioName: string;
  inviterName: string | null;
}

/** The live invite behind a plain token, with its still-pending, active user; null for anything else. */
async function resolveLiveInvite(db: DbLike, token: string, now: string): Promise<LiveInvite | null> {
  const row = await findLiveToken(db, token, "invite", now);
  if (!row) return null;
  const user = await first(db.select().from(users).where(eq(users.id, row.userId)));
  if (!user || !user.isActive || user.anonymisedAt || user.acceptedAt) return null;
  const org = await first(db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, user.organisationId)));
  if (!org) return null;
  const inviter = row.createdByUserId ? await first(db.select({ name: users.name }).from(users).where(eq(users.id, row.createdByUserId))) : undefined;
  return { tokenId: row.id, user, studioName: org.name, inviterName: inviter?.name ?? null };
}

/** GET /api/auth/invite/:token — what the accept page shows. Unknown / expired / used → `{ valid: false }`. */
export async function lookupInvite(db: DbLike, raw: unknown): Promise<InviteLookup> {
  const parsed = InviteTokenInput.safeParse(raw);
  if (!parsed.success) return { valid: false };
  const live = await resolveLiveInvite(db, parsed.data.token, nowIso());
  if (!live) return { valid: false };
  const persona = personaOfUser(live.user);
  const row = await findLiveToken(db, parsed.data.token, "invite", nowIso());
  return {
    valid: true,
    studioName: live.studioName,
    inviterName: live.inviterName,
    role: live.user.role,
    persona,
    personaLabel: PERSONA_LABELS[persona],
    email: live.user.email,
    name: live.user.name,
    expiresAt: row?.expiresAt ?? "",
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

/**
 * POST /api/auth/invite/:token/accept `{ password, name? }` (public). Validates the link, sets the password
 * and `accepted_at` (+ the name when given), bumps `session_version`, marks the token used, audits
 * `user.accepted_invite` as the person themself. Any invalid link → the one generic 400.
 */
export async function acceptInvite(db: Db, raw: unknown, opts: { requestId?: string } = {}): Promise<AcceptInviteResult> {
  const input = parseInput(AcceptInviteInput, raw);
  const passwordHash = await hashPassword(input.password);
  return withTx(
    async (tx) => {
      const now = nowIso();
      const live = await resolveLiveInvite(tx, input.token, now);
      if (!live) throw invalidInvite();
      // A client whose portal is closed (or archived) has no context → the same generic answer.
      const ctx = await buildContextFromDb(tx, live.user.id, { cause: "user", requestId: opts.requestId ?? currentRequestId() ?? newRequestId() });
      if (!ctx) throw invalidInvite();
      if (!(await markTokenUsed(tx, live.tokenId, now))) throw invalidInvite();
      const nextSession = live.user.sessionVersion + 1;
      const name = input.name ?? live.user.name;
      await tx
        .update(users)
        // Accepting signs the person in, so People's "Last signed in" reads now rather than "Never".
        .set({ passwordHash, acceptedAt: now, lastLoginAt: now, name, sessionVersion: nextSession, updatedAt: now, version: live.user.version + 1 })
        .where(eq(users.id, live.user.id));
      await recordEvent(tx, ctx, {
        entityType: "user",
        entityId: live.user.id,
        eventType: "user.accepted_invite",
        action: "accepted",
        previousValue: { acceptedAt: null, name: live.user.name },
        newValue: { acceptedAt: now, name },
        metadata: { targetUserId: live.user.id, ip: input.ip ?? null, userAgent: input.userAgent ?? null, nameChanged: name !== live.user.name },
        visibility: "management",
      });
      return { userId: live.user.id, organisationId: live.user.organisationId, name, email: live.user.email, role: live.user.role, sessionVersion: nextSession };
    },
    { db },
  );
}

/** Accept + the session cookie (route handlers). */
export async function acceptInviteAndSignIn(raw: unknown, opts: { requestId?: string; db?: Db } = {}): Promise<AcceptInviteResult> {
  const result = await acceptInvite(opts.db ?? getDb(), raw, opts);
  await createSession(result.userId, result.sessionVersion, sessionKindForRole(result.role), result.role);
  return result;
}
