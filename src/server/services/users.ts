/**
 * Users service (docs/ROLES.md §2.2, §3.4, §6.1, §7.1; ARCHITECTURE.md §4.5).
 *
 * Every mutation: permission check → Zod parse → writes (one tx) → recordEvent.
 * Passwords: bcrypt is slow, so the temp password + hash can be prepared
 * outside the transaction (`prepareTempPassword`) and passed in as `secret`;
 * when omitted the services hash it themselves (cost BCRYPT_COST). The
 * plaintext temp password is returned once and never stored or audited.
 *
 * Roles v2 model: three roles (photographer, editor, client). Admin is
 * `users.is_admin` on a photographer; one admin per organisation is the
 * PRIMARY owner (`organisation_settings.primary_owner_user_id`).
 *
 * Guards (service first with a friendly 422, DB trigger `users_keep_admin` as
 * the backstop — its message is mapped to the same 422):
 * - nobody deactivates themself, revokes their own admin or changes their own role;
 * - the last active admin can be neither deactivated, demoted to editor, nor
 *   have admin revoked (`last_admin`);
 * - the primary owner is protected from every other admin (hard rule in `can()`,
 *   403) and can only stop being an admin after transferring primary ownership
 *   (`primary_owner`);
 * - role changes are photographer ⇄ editor only (`role_change_not_allowed`
 *   for client ⇄ staff), reset the new role's switches to their invite
 *   defaults, and refuse to strand open assignments (reassign first);
 * - deactivating an admin clears admin (audited); reactivation returns a team member.
 *
 * Demo studio (docs/ACCOUNTS.md §7, `assertNotDemo`): no invites, no admin password resets, no email changes,
 * no primary-owner transfer, and the four persona accounts (DEMO_ACCOUNTS) cannot be deactivated, re-roled,
 * promoted / demoted, re-switched or anonymised — each a 403 with plain copy.
 *
 * `session_version` is bumped on deactivation, password reset, role change
 * and admin grant/revoke: every cookie issued before is revoked, so the person
 * signs in again under the new role. Permission switches (`setPermissions`)
 * do NOT sign the person out: the context is rebuilt from the user row on every
 * request, so a switch applies on their next request (integration decision).
 */
import { and, asc, count, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { isGuardViolation, isUniqueViolation, rootErrorMessage } from "@/db/errors";
import { authTokens, clients, jobs, organisationSettings, userNotificationPrefs, users } from "@/db/schema";
import {
  AVATAR_PALETTE,
  BCRYPT_COST,
  CATEGORY_GROUPS,
  CLIENT_NOTIFICATION_TYPES,
  EDITOR_FLAGS,
  EDITOR_INVITE_DEFAULTS,
  MEMBER_FLAGS,
  MEMBER_INVITE_DEFAULTS,
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_META,
  PERMISSION_FLAGS,
  personaMayEver,
  type Action,
  type InviteMethod,
  type NotificationType,
  type PermissionFlag,
  type Role,
} from "@/lib/constants";
import { newId } from "@/lib/ids";
import type { AuthContext, Client, User } from "@/lib/types";
import {
  ChangeRoleInput,
  ClientPortalUsersInput,
  DeactivateUserInput,
  InviteUserInput,
  SetAdminInput,
  SetCapacityInput,
  SetNotificationPrefsInput,
  SetPermissionsInput,
  TransferPrimaryOwnerInput,
  UpdateUserInput,
  UserIdInput,
} from "@/lib/validation/users";
import { recordEvent } from "@/server/audit";
import { generateTempPassword, hashPassword } from "@/server/auth/password";
import { assertCan, inviteSwitchesFor, isAdmin, personaOf, type UserPermissionRef } from "@/server/auth/permissions";
import { assertNotDemo, isDemoPersonaEmail } from "@/server/auth/demo";
import { clearEmailConfirmation } from "@/server/auth/email-confirmation";
import { consumeLiveTokens, issueToken, unusablePasswordHash } from "@/server/auth/tokens";
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "@/server/errors";
import { first, loadUserInOrg, one, parseInput, safeUser, withTx, type Db, type DbLike, type SafeUser, type Tx } from "./_shared";
import { UserRuleError, checkVersion, diffFields, ruleViolation } from "./_admin";
import { assignEditor, unassignEditor } from "./assignments";
import { closeRunningSessionForUser } from "./timeTracking";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

export const ANONYMISED_NAME = "Former team member";
export const ANONYMISED_AVATAR = "#94a3b8";

/** §6.1: one message for every email collision (no organisation name, no role). */
export const EMAIL_UNAVAILABLE_MESSAGE = "This email can't be used. Ask them for another address.";
export const LAST_ADMIN_MESSAGE = "Make another photographer an admin first";
export const PRIMARY_OWNER_MESSAGE = "Transfer primary ownership first";

export interface PreparedSecret {
  tempPassword: string;
  passwordHash: string;
}

/** Generates a temp password and hashes it (async; call before opening the transaction). */
export async function prepareTempPassword(cost: number = BCRYPT_COST): Promise<PreparedSecret> {
  const tempPassword = generateTempPassword();
  return { tempPassword, passwordHash: await hashPassword(tempPassword, cost) };
}

async function secretOrHash(secret: PreparedSecret | undefined): Promise<PreparedSecret> {
  return secret ?? prepareTempPassword(BCRYPT_COST);
}

export interface UserRefOptions {
  /** organisation_settings.primary_owner_user_id (sets `isPrimaryOwner`). */
  primaryOwnerId?: string | null;
  nextRole?: Role;
  nextIsAdmin?: boolean;
}

/** Permission ref of a target user (carries `isAdmin` / `isPrimaryOwner` for the hard rules, §3.4). */
export function userPermissionRef(row: User, opts: UserRefOptions = {}): UserPermissionRef {
  return {
    id: row.id,
    role: row.role,
    isActive: row.isActive,
    organisationId: row.organisationId,
    isAdmin: row.role === "photographer" && row.isAdmin,
    isPrimaryOwner: opts.primaryOwnerId != null && opts.primaryOwnerId === row.id,
    ...(opts.nextRole !== undefined ? { nextRole: opts.nextRole } : {}),
    ...(opts.nextIsAdmin !== undefined ? { nextIsAdmin: opts.nextIsAdmin } : {}),
  };
}

/** Persona pre-check before anything is loaded (the scoped check runs on the target ref). */
function assertMayEver(ctx: AuthContext, action: Action): void {
  if (!ctx.isActive || !personaMayEver(personaOf(ctx), action)) throw new ForbiddenError(action);
}

function requireHuman(ctx: AuthContext, action: string): string {
  if (!ctx.userId || ctx.isSystem) throw new ForbiddenError(action);
  return ctx.userId;
}

/**
 * The demo studio (docs/ACCOUNTS.md §7): the four persona accounts (`DEMO_ACCOUNTS`) ARE the demo — nobody can
 * deactivate, re-role, promote / demote, re-switch or anonymise them (403 `demo.demo_accounts`, plain copy).
 */
function assertNotDemoPersona(ctx: AuthContext, target: Pick<User, "email">): void {
  if (ctx.isDemo && isDemoPersonaEmail(target.email)) assertNotDemo(ctx, "demo_accounts");
}

/** organisation_settings.primary_owner_user_id of the actor's organisation. */
export async function primaryOwnerIdOf(db: DbLike, organisationId: string): Promise<string | null> {
  const row = await first(
    db.select({ id: organisationSettings.primaryOwnerUserId }).from(organisationSettings).where(eq(organisationSettings.organisationId, organisationId)),
  );
  return row?.id ?? null;
}

interface Target {
  target: User;
  primaryOwnerId: string | null;
}

/** Target user in the actor's organisation (foreign / missing → 404) + the org's primary owner. */
async function loadTarget(db: DbLike, ctx: AuthContext, userId: string): Promise<Target> {
  const target = await loadUserInOrg(db, ctx, userId);
  return { target, primaryOwnerId: await primaryOwnerIdOf(db, ctx.organisationId) };
}

function isActiveAdmin(user: Pick<User, "role" | "isAdmin" | "isActive">): boolean {
  return user.role === "photographer" && user.isAdmin && user.isActive;
}

/** Active admins (photographer ∧ is_admin ∧ is_active) of an organisation. */
export async function activeAdminCount(db: DbLike, organisationId: string, exceptUserId?: string): Promise<number> {
  const row = await first(
    db
      .select({ n: count() })
      .from(users)
      .where(
        and(
          eq(users.organisationId, organisationId),
          eq(users.role, "photographer"),
          eq(users.isAdmin, true),
          eq(users.isActive, true),
          exceptUserId ? ne(users.id, exceptUserId) : undefined,
        ),
      ),
  );
  return row?.n ?? 0;
}

/** Before an active admin stops being one: the org must keep another active admin (422 `last_admin`). */
async function assertKeepsAnAdmin(db: DbLike, target: User): Promise<void> {
  if (!isActiveAdmin(target)) return;
  if ((await activeAdminCount(db, target.organisationId, target.id)) === 0) {
    throw new UserRuleError("last_admin", `${target.name} is the only active admin. ${LAST_ADMIN_MESSAGE}.`);
  }
}

/** The primary owner must stay an active admin (422 `primary_owner`). Reached only by the owner themself. */
function assertNotPrimaryOwner(target: User, primaryOwnerId: string | null): void {
  if (primaryOwnerId !== null && target.id === primaryOwnerId) {
    throw new UserRuleError("primary_owner", `${target.name} is the primary owner. ${PRIMARY_OWNER_MESSAGE}.`);
  }
}

/**
 * Runs a users write and maps the `users_keep_admin` / `org_primary_owner`
 * trigger messages to the same 422s the service checks raise (§3.4: the
 * trigger is the backstop). The failed statement has aborted the transaction;
 * the caller's `withTx` rolls it back.
 */
async function guarded<T>(write: PromiseLike<T>): Promise<T> {
  try {
    return await write;
  } catch (err) {
    if (isGuardViolation(err)) {
      const message = rootErrorMessage(err);
      if (/at least one active admin/.test(message)) throw new UserRuleError("last_admin", `${LAST_ADMIN_MESSAGE}.`);
      if (/primary owner/.test(message)) throw new UserRuleError("primary_owner", `${PRIMARY_OWNER_MESSAGE}.`);
    }
    if (isUniqueViolation(err, "users_email_uq")) throw new ConflictError(EMAIL_UNAVAILABLE_MESSAGE);
    throw err;
  }
}

async function isEmailTaken(db: DbLike, email: string, exceptUserId?: string): Promise<boolean> {
  const row = await first(db.select({ id: users.id }).from(users).where(eq(users.email, email)));
  return !!row && row.id !== exceptUserId;
}

type FlagValues = Record<PermissionFlag, boolean>;

function flagsOf(row: Pick<User, PermissionFlag>): FlagValues {
  const out = {} as FlagValues;
  for (const f of PERMISSION_FLAGS) out[f] = row[f];
  return out;
}

/** The switches that matter for a role (admins: none — they have every permission). */
function relevantFlags(role: Role, admin: boolean): readonly PermissionFlag[] {
  if (role === "editor") return EDITOR_FLAGS;
  if (role === "photographer" && !admin) return MEMBER_FLAGS;
  return [];
}

function pickFlags(values: FlagValues, keys: readonly PermissionFlag[]): Partial<FlagValues> {
  const out: Partial<FlagValues> = {};
  for (const k of keys) out[k] = values[k];
  return out;
}

export interface OpenJobRef {
  jobId: string;
  jobNumber: string;
  role: "editor" | "photographer";
  version: number;
}

/** Active (non-terminal) jobs where the user is the current editor or photographer. */
export async function openJobsForUser(db: DbLike, ctx: AuthContext, userId: string): Promise<OpenJobRef[]> {
  const rows = await db
    .select({ id: jobs.id, jobNumber: jobs.jobNumber, editorId: jobs.editorId, photographerId: jobs.photographerId, version: jobs.version })
    .from(jobs)
    .where(
      and(
        eq(jobs.organisationId, ctx.organisationId),
        inArray(jobs.statusCategory, [...CATEGORY_GROUPS.ACTIVE]),
        or(eq(jobs.editorId, userId), eq(jobs.photographerId, userId)),
      ),
    )
    .orderBy(jobs.jobNumber, jobs.id);
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

/** A client of the organisation that can take portal users: non-archived with the portal on (§6.1). */
async function loadPortalClient(db: DbLike, ctx: AuthContext, clientId: string): Promise<Client> {
  const row = await first(db.select().from(clients).where(and(eq(clients.id, clientId), eq(clients.organisationId, ctx.organisationId))));
  if (!row) throw new NotFoundError("Client");
  if (row.archivedAt) throw new UserRuleError("client_portal_off", "This client is archived", "clientId");
  if (!row.portalEnabled) throw new UserRuleError("client_portal_off", "Turn on the client portal for this client first", "clientId");
  return row;
}

/* ------------------------------------------------------------------ */
/*  Invite                                                             */
/* ------------------------------------------------------------------ */

export interface InviteResult {
  user: SafeUser;
  /** How the person gets in (front door): a link they open, or a temp password read out to them. */
  method: InviteMethod;
  /** "temp_password" only. Shown once to the inviter; never stored in plaintext or audited. */
  tempPassword: string | null;
  /** "link" only: the plain token (show / email it once) and when it stops working. */
  invite: { token: string; expiresAt: string } | null;
}

/** Every switch column of a new user: the invite defaults of its role, overridden by the input (§2.2). */
function inviteFlagValues(data: InviteUserInput): FlagValues {
  if (data.role === "client") {
    const none = {} as FlagValues;
    for (const f of PERMISSION_FLAGS) none[f] = false;
    return none;
  }
  if (data.role === "editor") {
    return { ...MEMBER_INVITE_DEFAULTS, ...EDITOR_INVITE_DEFAULTS, ...definedOnly(data.flags) };
  }
  return { ...MEMBER_INVITE_DEFAULTS, canViewTeamJobs: false, ...definedOnly(data.flags) };
}

function definedOnly<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Admin only (`user.invite`). Photographer (team member, or co-owner with
 * `isAdmin` — also needs `user.set_admin`), editor, or client user of a
 * portal-enabled client. Omitted switches take the invite defaults (members:
 * review ✗). Email uniqueness is global: a taken address is a 409 that names
 * neither the organisation nor the role.
 *
 * Front door: `method` "link" (default) stores an UNUSABLE password hash, `accepted_at = null` and issues a
 * 7-day invite token (returned once in `invite.token`; audited `user.invite_sent`) — the person chooses their
 * own password through `acceptInvite`. `method` "temp_password" (or a prepared `secret`) is the old path:
 * a usable temp password, `accepted_at = now`.
 */
export async function inviteUser(tx: Tx, ctx: AuthContext, input: unknown, secret?: PreparedSecret): Promise<InviteResult> {
  assertMayEver(ctx, "user.invite");
  // Accounts: invites are off in the demo studio (the seed builds it before it is flagged as the demo).
  assertNotDemo(ctx, "invite");
  const actorId = requireHuman(ctx, "user.invite");
  const parsed = parseInput(InviteUserInput, input);
  // SIMPLIFICATION-PLAN §2: one preset ("Only their own shoots" / "Everything (co-owner)") pre-fills the
  // switches; explicit `isAdmin` / `flags` still win.
  const preset = parsed.role === "photographer" ? parsed.preset : undefined;
  const data: InviteUserInput =
    parsed.role === "photographer" && preset
      ? { ...parsed, ...inviteSwitchesFor(preset, { isAdmin: parsed.isAdmin, flags: parsed.flags }) }
      : parsed;
  const method: InviteMethod = secret ? "temp_password" : (data.method ?? "link");
  const newRef: UserPermissionRef = { id: "new", role: data.role, isActive: true, organisationId: ctx.organisationId, nextRole: data.role };
  assertCan(ctx, "user.invite", newRef);
  const makeAdmin = data.role === "photographer" && data.isAdmin === true;
  if (makeAdmin) assertCan(ctx, "user.set_admin", { ...newRef, nextIsAdmin: true });
  const client = data.role === "client" ? await loadPortalClient(tx, ctx, data.clientId) : null;
  if (await isEmailTaken(tx, data.email)) throw new ConflictError(EMAIL_UNAVAILABLE_MESSAGE);

  const prepared = method === "temp_password" ? await secretOrHash(secret) : null;
  const now = ctx.now();
  const flags = inviteFlagValues(data);
  const row = await guarded(
    one(
      tx
        .insert(users)
        .values({
          organisationId: ctx.organisationId,
          email: data.email,
          passwordHash: prepared ? prepared.passwordHash : unusablePasswordHash(),
          // Accounts: a link-invitee has no usable password until they accept (with a password, or with Google).
          hasPassword: prepared !== null,
          name: data.name,
          role: data.role,
          title: data.role === "client" ? null : (data.title ?? null),
          avatarColour: data.avatarColour ?? AVATAR_PALETTE[Math.floor(Date.parse(now) / 1000) % AVATAR_PALETTE.length],
          capacityHoursPerWeek: data.role === "client" ? null : (data.capacityHoursPerWeek ?? null),
          usualCapacityJobs: data.role === "editor" ? (data.usualCapacityJobs ?? null) : null,
          isAdmin: makeAdmin,
          ...flags,
          clientId: client?.id ?? null,
          isActive: true,
          invitedAt: now,
          acceptedAt: prepared ? now : null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
    ),
  );
  await recordEvent(tx, ctx, {
    entityType: "user",
    entityId: row.id,
    eventType: "user.created",
    action: "created",
    previousValue: null,
    newValue: {
      name: row.name,
      email: row.email,
      role: row.role,
      isAdmin: row.isAdmin,
      clientId: row.clientId,
      title: row.title,
      capacityHoursPerWeek: row.capacityHoursPerWeek,
      usualCapacityJobs: row.usualCapacityJobs,
      flags: pickFlags(flagsOf(row), relevantFlags(row.role, row.isAdmin)),
    },
    metadata: { targetUserId: row.id, method, ...(client ? { clientName: client.name } : {}), ...(preset ? { preset } : {}) },
  });
  if (prepared) return { user: safeUser(row), method, tempPassword: prepared.tempPassword, invite: null };

  const issued = await issueToken(tx, { organisationId: ctx.organisationId, userId: row.id, kind: "invite", createdByUserId: actorId, now });
  await recordEvent(tx, ctx, {
    entityType: "user",
    entityId: row.id,
    eventType: "user.invite_sent",
    action: "invited",
    previousValue: null,
    newValue: { name: row.name, email: row.email, role: row.role, expiresAt: issued.expiresAt },
    metadata: { targetUserId: row.id, targetName: row.name, resend: false, superseded: 0, method },
  });
  return { user: safeUser(row), method, tempPassword: null, invite: { token: issued.token, expiresAt: issued.expiresAt } };
}

/** Async convenience: hashes outside the transaction, then runs `inviteUser` with method "temp_password". */
export async function inviteUserWithTempPassword(ctx: AuthContext, input: unknown, db?: Db): Promise<InviteResult> {
  assertMayEver(ctx, "user.invite");
  assertNotDemo(ctx, "invite");
  const secret = await prepareTempPassword();
  return withTx((tx) => inviteUser(tx, ctx, input, secret), { db });
}

/**
 * `POST /api/users`: picks the path from `method` in the body ("link" by default — no bcrypt, the token is
 * issued in the transaction; "temp_password" → `inviteUserWithTempPassword`).
 */
export async function inviteUserByMethod(ctx: AuthContext, input: unknown, db?: Db): Promise<InviteResult> {
  assertMayEver(ctx, "user.invite");
  assertNotDemo(ctx, "invite");
  const method = input && typeof input === "object" && !Array.isArray(input) ? (input as { method?: unknown }).method : undefined;
  if (method === "temp_password") return inviteUserWithTempPassword(ctx, input, db);
  return withTx((tx) => inviteUser(tx, ctx, input), { db });
}

/* ------------------------------------------------------------------ */
/*  Profile                                                            */
/* ------------------------------------------------------------------ */

const SELF_FIELDS = ["name", "title", "avatarColour"] as const;
const CLIENT_SELF_FIELDS = ["name"] as const;
const PROFILE_FIELDS = ["name", "title", "avatarColour", "email"] as const;

/**
 * `user.edit`: admins edit anyone (never the primary owner unless they are the
 * primary owner: hard rule, 403); everyone else edits only themself — staff
 * name/title/avatar, client users their name. An email change additionally
 * needs `user.change_email` (admins: self, or anyone but the primary owner).
 */
export async function updateUser(tx: Tx, ctx: AuthContext, input: unknown): Promise<SafeUser> {
  const actorId = requireHuman(ctx, "user.edit");
  const data = parseInput(UpdateUserInput, input);
  const { target, primaryOwnerId } = await loadTarget(tx, ctx, data.userId);
  const ref = userPermissionRef(target, { primaryOwnerId });
  assertCan(ctx, "user.edit", ref);
  if (data.email !== undefined && !isAdmin(ctx)) throw new ForbiddenError("user.change_email", "Only an admin can change an email address");
  if (data.email !== undefined) assertCan(ctx, "user.change_email", ref);
  if (ctx.role === "client" && (data.title !== undefined || data.avatarColour !== undefined)) {
    throw new ForbiddenError("user.edit", "Only your name can be changed here");
  }
  assertNotAnonymised(target);
  checkVersion(target, data.expectedVersion, safeUser(target));

  const fields = isAdmin(ctx) ? PROFILE_FIELDS : ctx.role === "client" ? CLIENT_SELF_FIELDS : SELF_FIELDS;
  const diff = diffFields(target, data, fields);
  if (diff.changed.length === 0) return safeUser(target);
  // Accounts: email addresses are fixed in the demo studio (sending the unchanged address along is fine).
  if (diff.set.email !== undefined) assertNotDemo(ctx, "email");
  if (diff.set.email && (await isEmailTaken(tx, diff.set.email, target.id))) throw new ConflictError(EMAIL_UNAVAILABLE_MESSAGE);
  // Accounts: a new address is not confirmed yet (and any confirm / change / reset link for the old one stops working).
  if (diff.set.email) await clearEmailConfirmation(tx, { userId: target.id, now: ctx.now() });
  // SEC-08: an invite link that went to the OLD address of someone who has not joined yet stops working too (whoever
  // reads that mailbox must not join as them); the People page then offers "Send a new link".
  const invitesClosed = diff.set.email && target.acceptedAt === null ? await consumeLiveTokens(tx, target.id, "invite", ctx.now()) : 0;
  const row = await guarded(
    one(
      tx
        .update(users)
        .set({ ...diff.set, updatedAt: ctx.now(), version: target.version + 1 })
        .where(eq(users.id, target.id))
        .returning(),
    ),
  );
  await recordEvent(tx, ctx, {
    entityType: "user",
    entityId: target.id,
    eventType: "user.updated",
    action: "updated",
    previousValue: diff.previous,
    newValue: diff.next,
    metadata: { targetUserId: target.id, targetName: row.name, self: target.id === actorId, ...(invitesClosed > 0 ? { invitesClosed } : {}) },
  });
  return safeUser(row);
}

/* ------------------------------------------------------------------ */
/*  Role                                                               */
/* ------------------------------------------------------------------ */

/**
 * photographer ⇄ editor only (§3.4). Client ⇄ staff → 422
 * `role_change_not_allowed`; self → 403; the primary owner → 403 (others) /
 * 422 (backstop). Photographer → editor also clears admin (last-admin guard).
 * The new role's switches reset to their invite defaults (`metadata.flagsReset`).
 */
export async function changeRole(tx: Tx, ctx: AuthContext, input: unknown): Promise<SafeUser> {
  assertMayEver(ctx, "user.change_role");
  requireHuman(ctx, "user.change_role");
  const data = parseInput(ChangeRoleInput, input);
  const { target, primaryOwnerId } = await loadTarget(tx, ctx, data.userId);
  if ((target.role === "client") !== (data.role === "client")) {
    throw new UserRuleError(
      "role_change_not_allowed",
      "Client accounts and studio accounts can't be converted into each other. Create a new account instead.",
      "role",
    );
  }
  assertCan(ctx, "user.change_role", userPermissionRef(target, { primaryOwnerId, nextRole: data.role }));
  assertNotDemoPersona(ctx, target);
  assertNotAnonymised(target);
  checkVersion(target, data.expectedVersion, safeUser(target));
  if (target.role === data.role) return safeUser(target);

  const wasAdmin = target.role === "photographer" && target.isAdmin;
  if (wasAdmin) {
    assertNotPrimaryOwner(target, primaryOwnerId);
    await assertKeepsAnAdmin(tx, target);
  }

  const open = await openJobsForUser(tx, ctx, target.id);
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

  // Reset the NEW role's switches to their invite defaults (§2.2); the other role's columns are ignored.
  const defaults: Partial<FlagValues> = data.role === "editor" ? { ...EDITOR_INVITE_DEFAULTS } : { ...MEMBER_INVITE_DEFAULTS };
  const flagsReset: Record<string, { from: boolean; to: boolean }> = {};
  for (const [flag, to] of Object.entries(defaults) as [PermissionFlag, boolean][]) {
    if (target[flag] !== to) flagsReset[flag] = { from: target[flag], to };
  }

  const row = await guarded(
    one(
      tx
        .update(users)
        .set({
          role: data.role,
          isAdmin: false,
          ...defaults,
          sessionVersion: target.sessionVersion + 1,
          updatedAt: ctx.now(),
          version: target.version + 1,
        })
        .where(eq(users.id, target.id))
        .returning(),
    ),
  );
  await recordEvent(tx, ctx, {
    entityType: "user",
    entityId: target.id,
    eventType: "user.role_changed",
    action: "updated",
    previousValue: { role: target.role, isAdmin: wasAdmin, name: target.name },
    newValue: { role: row.role, isAdmin: row.isAdmin, name: row.name },
    metadata: { targetUserId: target.id, flagsReset },
  });
  if (wasAdmin) {
    await recordEvent(tx, ctx, {
      entityType: "user",
      entityId: target.id,
      eventType: "user.admin_changed",
      action: "updated",
      previousValue: { isAdmin: true, name: target.name },
      newValue: { isAdmin: false, name: target.name },
      metadata: { targetUserId: target.id, targetName: target.name, reason: "role_changed" },
    });
  }
  return safeUser(row);
}

/* ------------------------------------------------------------------ */
/*  Admin, permission switches, primary owner                          */
/* ------------------------------------------------------------------ */

/**
 * POST /api/users/:id/admin `{ isAdmin, expectedVersion }` (`user.set_admin`):
 * grant to / revoke from another active photographer. Revoking keeps the stored
 * member switches (they apply again). Last-admin and primary-owner guards apply.
 */
export async function setAdmin(tx: Tx, ctx: AuthContext, input: unknown): Promise<SafeUser> {
  assertMayEver(ctx, "user.set_admin");
  requireHuman(ctx, "user.set_admin");
  const data = parseInput(SetAdminInput, input);
  const { target, primaryOwnerId } = await loadTarget(tx, ctx, data.userId);
  assertCan(ctx, "user.set_admin", userPermissionRef(target, { primaryOwnerId, nextIsAdmin: data.isAdmin }));
  assertNotDemoPersona(ctx, target);
  assertNotAnonymised(target);
  checkVersion(target, data.expectedVersion, safeUser(target));
  if (target.isAdmin === data.isAdmin) return safeUser(target);
  if (!data.isAdmin) {
    assertNotPrimaryOwner(target, primaryOwnerId);
    await assertKeepsAnAdmin(tx, target);
  }
  const row = await guarded(
    one(
      tx
        .update(users)
        .set({ isAdmin: data.isAdmin, sessionVersion: target.sessionVersion + 1, updatedAt: ctx.now(), version: target.version + 1 })
        .where(eq(users.id, target.id))
        .returning(),
    ),
  );
  await recordEvent(tx, ctx, {
    entityType: "user",
    entityId: target.id,
    eventType: "user.admin_changed",
    action: "updated",
    previousValue: { isAdmin: target.isAdmin, name: target.name },
    newValue: { isAdmin: row.isAdmin, name: row.name },
    metadata: { targetUserId: target.id, targetName: target.name },
  });
  return safeUser(row);
}

/**
 * POST /api/users/:id/permissions (`user.set_permissions`, replaces the v1
 * visibility flags): member switches on an active non-admin photographer,
 * editor switches on an active editor. Admin target → 422 "Admins have every
 * permission"; a switch outside the target's role → 422. One
 * `user.flags_changed` event with the changed switches only.
 */
export async function setPermissions(tx: Tx, ctx: AuthContext, input: unknown): Promise<SafeUser> {
  assertMayEver(ctx, "user.set_permissions");
  requireHuman(ctx, "user.set_permissions");
  const data = parseInput(SetPermissionsInput, input);
  const { target, primaryOwnerId } = await loadTarget(tx, ctx, data.userId);
  if (target.role === "client") throw new UserRuleError("not_staff", "Client users have no permission switches");
  if (target.role === "photographer" && target.isAdmin) {
    throw new UserRuleError("admin_has_every_permission", "Admins have every permission");
  }
  const allowed = relevantFlags(target.role, false);
  const outside = PERMISSION_FLAGS.filter((f) => data[f] !== undefined && !allowed.includes(f));
  if (outside.length > 0) {
    const who = target.role === "editor" ? "editors" : "team members";
    throw new UserRuleError("flag_not_for_role", `These switches don't apply to ${who}: ${outside.join(", ")}`, outside[0]);
  }
  assertCan(ctx, "user.set_permissions", userPermissionRef(target, { primaryOwnerId }));
  assertNotDemoPersona(ctx, target);
  assertNotAnonymised(target);
  checkVersion(target, data.expectedVersion, safeUser(target));
  const diff = diffFields(target, data, allowed);
  if (diff.changed.length === 0) return safeUser(target);
  const row = await one(
    tx
      .update(users)
      // No session_version bump: contexts are rebuilt from this row on every request, so a switch (granted or
      // revoked) applies on the person's next request without signing them out (docs/ROLES.md e2e "applies at once").
      .set({ ...diff.set, updatedAt: ctx.now(), version: target.version + 1 })
      .where(eq(users.id, target.id))
      .returning(),
  );
  await recordEvent(tx, ctx, {
    entityType: "user",
    entityId: target.id,
    eventType: "user.flags_changed",
    action: "updated",
    previousValue: diff.previous,
    newValue: diff.next,
    metadata: { targetUserId: target.id, targetName: target.name, changedFlags: diff.changed },
  });
  return safeUser(row);
}

export interface PrimaryOwnerResult {
  primaryOwnerUserId: string;
  previousPrimaryOwnerUserId: string | null;
  settingsVersion: number;
}

/**
 * POST /api/organisation/primary-owner `{ userId, expectedVersion }`
 * (`org.transfer_primary_owner`): only the primary owner, to another active
 * admin. The old owner stays an admin. `expectedVersion` = organisation_settings.version.
 */
export async function transferPrimaryOwner(tx: Tx, ctx: AuthContext, input: unknown): Promise<PrimaryOwnerResult> {
  assertMayEver(ctx, "org.transfer_primary_owner");
  requireHuman(ctx, "org.transfer_primary_owner");
  // Accounts: the demo's Owner persona stays its primary owner.
  assertNotDemo(ctx, "demo_accounts");
  const data = parseInput(TransferPrimaryOwnerInput, input);
  const { target, primaryOwnerId } = await loadTarget(tx, ctx, data.userId);
  assertCan(ctx, "org.transfer_primary_owner", userPermissionRef(target, { primaryOwnerId }));
  const settings = await first(tx.select().from(organisationSettings).where(eq(organisationSettings.organisationId, ctx.organisationId)));
  if (!settings) throw new NotFoundError("Organisation settings");
  checkVersion(settings, data.expectedVersion, { primaryOwnerUserId: settings.primaryOwnerUserId, version: settings.version });
  const previous = primaryOwnerId ? await first(tx.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, primaryOwnerId))) : undefined;
  const updated = await guarded(
    one(
      tx
        .update(organisationSettings)
        .set({ primaryOwnerUserId: target.id, updatedAt: ctx.now(), version: settings.version + 1 })
        .where(eq(organisationSettings.organisationId, ctx.organisationId))
        .returning({ version: organisationSettings.version }),
    ),
  );
  await recordEvent(tx, ctx, {
    entityType: "settings",
    entityId: ctx.organisationId,
    eventType: "settings.primary_owner_changed",
    action: "updated",
    previousValue: { userId: previous?.id ?? null, name: previous?.name ?? null },
    newValue: { userId: target.id, name: target.name },
    metadata: { targetUserId: target.id, targetName: target.name },
  });
  return { primaryOwnerUserId: target.id, previousPrimaryOwnerUserId: primaryOwnerId, settingsVersion: updated.version };
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
 * Roles v2 (§3.4): never self, never the primary owner (by others: 403),
 * never the last active admin (422); an admin loses admin in the same
 * transaction (`user.admin_changed`, reason "deactivated").
 */
export async function deactivateUser(tx: Tx, ctx: AuthContext, input: unknown): Promise<DeactivateResult> {
  assertMayEver(ctx, "user.deactivate");
  const actorId = requireHuman(ctx, "user.deactivate");
  const data = parseInput(DeactivateUserInput, input);
  const { target, primaryOwnerId } = await loadTarget(tx, ctx, data.userId);
  assertCan(ctx, "user.deactivate", userPermissionRef(target, { primaryOwnerId }));
  assertNotDemoPersona(ctx, target);
  checkVersion(target, data.expectedVersion, safeUser(target));
  if (!target.isActive) throw ruleViolation(`${target.name} is already deactivated`);
  const wasAdmin = target.role === "photographer" && target.isAdmin;
  if (wasAdmin) {
    assertNotPrimaryOwner(target, primaryOwnerId);
    await assertKeepsAnAdmin(tx, target);
  }

  let reassignTo: User | null = null;
  if (data.reassignTo) {
    reassignTo = await loadUserInOrg(tx, ctx, data.reassignTo);
    if (reassignTo.id === target.id) throw ruleViolation("Choose a different editor to take over", {}, "reassignTo");
    if (!reassignTo.isActive || reassignTo.role !== "editor") {
      throw ruleViolation("Jobs can only be reassigned to an active editor", {}, "reassignTo");
    }
  }

  const now = ctx.now();
  // 1. Stop the running timer first so it ends with the deactivation reason.
  await closeRunningSessionForUser(tx, ctx, { userId: target.id, reason: "auto_deactivated" });

  // 2. Revoke access immediately (and admin: reactivation returns a team member).
  const row = await guarded(
    one(
      tx
        .update(users)
        .set({
          isActive: false,
          isAdmin: false,
          deactivatedAt: now,
          deactivatedByUserId: actorId,
          sessionVersion: target.sessionVersion + 1,
          updatedAt: now,
          version: target.version + 1,
        })
        .where(eq(users.id, target.id))
        .returning(),
    ),
  );

  // 3. Hand over open editor jobs.
  const openJobs: DeactivateResult["openJobs"] = [];
  for (const job of await openJobsForUser(tx, ctx, target.id)) {
    let action: OpenJobAction = "kept";
    if (job.role === "editor" && reassignTo) {
      await assignEditor(tx, ctx, { jobId: job.jobId, userId: reassignTo.id, reason: "user_deactivated", unassignReason: "user_deactivated" });
      action = "reassigned";
    } else if (job.role === "editor" && data.unassign) {
      await unassignEditor(tx, ctx, { jobId: job.jobId, userId: null, reason: "user_deactivated", unassignReason: "user_deactivated" });
      action = "unassigned";
    }
    openJobs.push({ jobId: job.jobId, jobNumber: job.jobNumber, role: job.role, action });
  }

  await recordEvent(tx, ctx, {
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
      ...(wasAdmin ? { adminCleared: true } : {}),
    },
  });
  if (wasAdmin) {
    await recordEvent(tx, ctx, {
      entityType: "user",
      entityId: target.id,
      eventType: "user.admin_changed",
      action: "updated",
      previousValue: { isAdmin: true, name: target.name },
      newValue: { isAdmin: false, name: target.name },
      metadata: { targetUserId: target.id, targetName: target.name, reason: "deactivated" },
    });
  }
  return { user: safeUser(row), openJobs };
}

/** Reactivates a user. A former admin comes back as a team member (admin is re-granted only via `setAdmin`). */
export async function reactivateUser(tx: Tx, ctx: AuthContext, input: unknown): Promise<SafeUser> {
  assertMayEver(ctx, "user.reactivate");
  requireHuman(ctx, "user.reactivate");
  const data = parseInput(UserIdInput, input);
  const { target, primaryOwnerId } = await loadTarget(tx, ctx, data.userId);
  assertCan(ctx, "user.reactivate", userPermissionRef(target, { primaryOwnerId }));
  assertNotAnonymised(target);
  checkVersion(target, data.expectedVersion, safeUser(target));
  if (target.isActive) throw ruleViolation(`${target.name} is already active`);
  const row = await one(
    tx
      .update(users)
      .set({ isActive: true, deactivatedAt: null, deactivatedByUserId: null, updatedAt: ctx.now(), version: target.version + 1 })
      .where(eq(users.id, target.id))
      .returning(),
  );
  await recordEvent(tx, ctx, {
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
 * Admin reset (`user.reset_password`: admins any staff or client user except
 * the primary owner; everyone self): sets a fresh temp password and bumps
 * `session_version`. Changing your own password with the current one is
 * `changePassword` in services/auth.ts.
 */
export async function resetPassword(tx: Tx, ctx: AuthContext, input: unknown, secret?: PreparedSecret): Promise<ResetPasswordResult> {
  assertMayEver(ctx, "user.reset_password");
  // Accounts: nobody's password changes in the demo studio (the personas share one).
  assertNotDemo(ctx, "reset_password");
  const actorId = requireHuman(ctx, "user.reset_password");
  const data = parseInput(UserIdInput, input);
  const { target, primaryOwnerId } = await loadTarget(tx, ctx, data.userId);
  assertCan(ctx, "user.reset_password", userPermissionRef(target, { primaryOwnerId }));
  assertNotAnonymised(target);
  checkVersion(target, data.expectedVersion, safeUser(target));
  const { tempPassword, passwordHash } = await secretOrHash(secret);
  const nextSession = target.sessionVersion + 1;
  const now = ctx.now();
  // Front door: a temp password is a usable password, so a still-pending invitee counts as accepted from here
  // and any live invite link of theirs stops working (fill-once used_at).
  const pendingInvite = target.acceptedAt === null;
  const superseded = pendingInvite ? await consumeLiveTokens(tx, target.id, "invite", now) : 0;
  await tx
    .update(users)
    .set({ passwordHash, hasPassword: true, sessionVersion: nextSession, updatedAt: now, version: target.version + 1, ...(pendingInvite ? { acceptedAt: now } : {}) })
    .where(eq(users.id, target.id));
  await recordEvent(tx, ctx, {
    entityType: "user",
    entityId: target.id,
    eventType: "user.password_changed",
    action: "updated",
    previousValue: { sessionVersion: target.sessionVersion },
    newValue: { sessionVersion: nextSession, name: target.name },
    metadata: {
      targetUserId: target.id,
      self: target.id === actorId,
      reset: true,
      // (the audit redactor drops keys matching /password/i, so the method is a VALUE here)
      ...(pendingInvite ? { acceptedVia: "temp_password" satisfies InviteMethod, invitesSuperseded: superseded } : {}),
    },
  });
  return { userId: target.id, tempPassword };
}

/** Async convenience: hashes outside the transaction, then runs `resetPassword`. */
export async function resetPasswordWithTempPassword(ctx: AuthContext, input: unknown, db?: Db): Promise<ResetPasswordResult> {
  assertMayEver(ctx, "user.reset_password");
  assertNotDemo(ctx, "reset_password");
  const secret = await prepareTempPassword();
  return withTx((tx) => resetPassword(tx, ctx, input, secret), { db });
}

/* ------------------------------------------------------------------ */
/*  Capacity                                                           */
/* ------------------------------------------------------------------ */

export async function setCapacity(tx: Tx, ctx: AuthContext, input: unknown): Promise<SafeUser> {
  assertMayEver(ctx, "user.set_capacity");
  requireHuman(ctx, "user.set_capacity");
  const data = parseInput(SetCapacityInput, input);
  const { target, primaryOwnerId } = await loadTarget(tx, ctx, data.userId);
  if (target.role === "client") throw new UserRuleError("not_staff", "Client users have no capacity", "capacityHoursPerWeek");
  assertCan(ctx, "user.set_capacity", userPermissionRef(target, { primaryOwnerId }));
  assertNotAnonymised(target);
  checkVersion(target, data.expectedVersion, safeUser(target));
  if (target.capacityHoursPerWeek === data.capacityHoursPerWeek) return safeUser(target);
  const row = await one(
    tx
      .update(users)
      .set({ capacityHoursPerWeek: data.capacityHoursPerWeek, updatedAt: ctx.now(), version: target.version + 1 })
      .where(eq(users.id, target.id))
      .returning(),
  );
  await recordEvent(tx, ctx, {
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

/* ------------------------------------------------------------------ */
/*  Client portal users (§7.1)                                         */
/* ------------------------------------------------------------------ */

export interface ClientPortalUser {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  deactivatedAt: string | null;
  lastLoginAt: string | null;
  avatarColour: string;
  version: number;
}

/**
 * GET /api/clients/:id/portal-users (`client.manage_portal`, admin): the
 * client's portal accounts, active first. Invite with `inviteUser({ role:
 * "client", clientId })`; deactivate / reactivate / reset with the usual services.
 */
export async function listClientPortalUsers(db: DbLike, ctx: AuthContext, input: unknown): Promise<ClientPortalUser[]> {
  assertCan(ctx, "client.manage_portal");
  const data = parseInput(ClientPortalUsersInput, input);
  const client = await first(db.select({ id: clients.id }).from(clients).where(and(eq(clients.id, data.clientId), eq(clients.organisationId, ctx.organisationId))));
  if (!client) throw new NotFoundError("Client");
  assertCan(ctx, "client.manage_portal", { organisationId: ctx.organisationId });
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      isActive: users.isActive,
      deactivatedAt: users.deactivatedAt,
      lastLoginAt: users.lastLoginAt,
      avatarColour: users.avatarColour,
      version: users.version,
    })
    .from(users)
    .where(and(eq(users.organisationId, ctx.organisationId), eq(users.role, "client"), eq(users.clientId, client.id)))
    .orderBy(asc(users.name), asc(users.id));
  return rows.sort((a, b) => Number(b.isActive) - Number(a.isActive));
}

/* ------------------------------------------------------------------ */
/*  Anonymise                                                          */
/* ------------------------------------------------------------------ */

/**
 * Admin-only, target must already be deactivated (§5 Anonymisation):
 * rewrites PII on the users row only. Comments and events stay; names are
 * joined at read time, so feeds show "Former team member".
 */
export async function anonymiseUser(tx: Tx, ctx: AuthContext, input: unknown): Promise<SafeUser> {
  assertMayEver(ctx, "user.anonymise");
  requireHuman(ctx, "user.anonymise");
  const data = parseInput(UserIdInput, input);
  const { target, primaryOwnerId } = await loadTarget(tx, ctx, data.userId);
  if (target.isActive) throw ruleViolation("Deactivate this user before anonymising them");
  assertCan(ctx, "user.anonymise", userPermissionRef(target, { primaryOwnerId }));
  assertNotDemoPersona(ctx, target);
  checkVersion(target, data.expectedVersion, safeUser(target));
  if (target.anonymisedAt) throw ruleViolation("This user is already anonymised");
  const now = ctx.now();
  const row = await one(
    tx
      .update(users)
      .set({
        name: ANONYMISED_NAME,
        email: `anon-${target.id}@invalid`,
        // Not a bcrypt hash: verifyPassword() returns false for it, so nobody can log in.
        passwordHash: `!anonymised!${newId()}${newId()}`,
        // Accounts: no way in at all — no password, no Google account (PII too).
        hasPassword: false,
        googleSub: null,
        googleEmail: null,
        avatarColour: ANONYMISED_AVATAR,
        title: null,
        anonymisedAt: now,
        sessionVersion: target.sessionVersion + 1,
        updatedAt: now,
        version: target.version + 1,
      })
      .where(eq(users.id, target.id))
      .returning(),
  );
  const linksClosed = await closeLinksOnAnonymise(tx, target.id, now);
  await recordEvent(tx, ctx, {
    entityType: "user",
    entityId: target.id,
    eventType: "user.anonymised",
    action: "anonymised",
    previousValue: { anonymisedAt: null },
    newValue: { anonymisedAt: now, name: ANONYMISED_NAME },
    metadata: { targetUserId: target.id, ...(linksClosed > 0 ? { linksClosed } : {}) },
  });
  return safeUser(row);
}

/**
 * DATA-02: anonymising leaves no way in and no address behind in the link ledger. Every link of the person that still
 * works (invite, reset, confirm, email change) is used up (fill-once), and the address an email link was sent to
 * (`auth_tokens.target_email`, e.g. a private address they were moving to) is scrubbed to NULL — the one change the
 * fill-once guard allows on a used row (migration 0008). Rows are never deleted. Returns how many links still worked.
 * (The append-only history keeps its frozen sentences, as for every other event — ARCHITECTURE.md §5.)
 */
async function closeLinksOnAnonymise(tx: Tx, userId: string, now: string): Promise<number> {
  const closed = await tx
    .update(authTokens)
    .set({ usedAt: now })
    .where(and(eq(authTokens.userId, userId), isNull(authTokens.usedAt), isNull(authTokens.targetEmail), gt(authTokens.expiresAt, now)))
    .returning({ id: authTokens.id });
  const live = await tx
    .select({ id: authTokens.id })
    .from(authTokens)
    .where(and(eq(authTokens.userId, userId), isNull(authTokens.usedAt), isNotNull(authTokens.targetEmail), gt(authTokens.expiresAt, now)));
  // Only rows that still carry an address are touched here (an older database without 0008 never sees this UPDATE
  // for someone who has none).
  await tx
    .update(authTokens)
    .set({ usedAt: sql`coalesce(${authTokens.usedAt}, ${now})`, targetEmail: null })
    .where(and(eq(authTokens.userId, userId), isNotNull(authTokens.targetEmail)));
  return closed.length + live.length;
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

/** Types a user of `role` can receive (§6.2: clients only the client types; staff never them). */
export function notificationTypesFor(role: Role): readonly NotificationType[] {
  const clientTypes: readonly NotificationType[] = CLIENT_NOTIFICATION_TYPES;
  return role === "client" ? clientTypes : NOTIFICATION_TYPES.filter((t) => !clientTypes.includes(t));
}

/**
 * Own preferences for the types the user can receive. Missing row = the type's `defaultOn`
 * (SIMPLIFICATION-PLAN §8: the 8 default groups on, the rest off; client types on); mandatory types always on.
 */
export async function getNotificationPrefs(db: DbLike, ctx: AuthContext, userId?: string): Promise<NotificationPrefView[]> {
  const target = userId ?? ctx.userId;
  if (!target) throw new UnauthorizedError();
  assertCan(ctx, "notification.prefs", { userId: target, organisationId: ctx.organisationId });
  const user = await loadUserInOrg(db, ctx, target);
  const rows = await db.select().from(userNotificationPrefs).where(eq(userNotificationPrefs.userId, target));
  const byType = new Map(rows.map((r) => [r.type, r.enabled]));
  return notificationTypesFor(user.role).map((type) => {
    const meta = NOTIFICATION_TYPE_META[type];
    const defaultOn = meta.defaultOn || user.role === "client";
    return { type, label: meta.label, mandatory: meta.mandatory, enabled: meta.mandatory ? true : (byType.get(type) ?? defaultOn) };
  });
}

export async function setNotificationPrefs(tx: Tx, ctx: AuthContext, input: unknown): Promise<NotificationPrefView[]> {
  const actorId = requireHuman(ctx, "notification.prefs");
  assertCan(ctx, "notification.prefs", { userId: actorId, organisationId: ctx.organisationId });
  const data = parseInput(SetNotificationPrefsInput, input);
  const target = data.userId ?? actorId;
  assertCan(ctx, "notification.prefs", { userId: target, organisationId: ctx.organisationId });

  const views = await getNotificationPrefs(tx, ctx, target);
  const current = new Map(views.map((p) => [p.type, p.enabled]));
  const previous: Record<string, boolean> = {};
  const next: Record<string, boolean> = {};
  const now = ctx.now();
  for (const type of NOTIFICATION_TYPES) {
    const enabled = data.prefs[type];
    if (enabled === undefined) continue;
    if (!current.has(type)) throw ruleViolation(`"${NOTIFICATION_TYPE_META[type].label}" notifications are not available for this account`, {}, `prefs.${type}`);
    if (NOTIFICATION_TYPE_META[type].mandatory) {
      if (!enabled) throw ruleViolation(`"${NOTIFICATION_TYPE_META[type].label}" notifications cannot be turned off`, {}, `prefs.${type}`);
      continue;
    }
    if (current.get(type) === enabled) continue;
    previous[type] = current.get(type) ?? NOTIFICATION_TYPE_META[type].defaultOn;
    next[type] = enabled;
    await tx
      .insert(userNotificationPrefs)
      .values({ organisationId: ctx.organisationId, userId: target, type, enabled, updatedAt: now })
      .onConflictDoUpdate({ target: [userNotificationPrefs.userId, userNotificationPrefs.type], set: { enabled, updatedAt: now } });
  }
  if (Object.keys(next).length > 0) {
    await recordEvent(tx, ctx, {
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
