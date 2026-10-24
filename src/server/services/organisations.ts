/**
 * Organisations: the ONE bootstrap of a studio's structure, and public sign-up ("Create your studio").
 *
 *   createOrganisationWithOwner(tx, …)  organisation + settings row + the first owner (admin photographer,
 *                                       primary owner, every switch on) — the only raw user insert outside
 *                                       inviteUser; audits org.created + user.created
 *   bootstrapOrganisation(tx, …)        the structure every studio starts with, through the real admin
 *                                       services as the owner: the default workflow (13 statuses, every
 *                                       default edge + a cancel edge per open status), DEFAULT_JOB_TYPES bound
 *                                       to it with "usual days to edit"; settings keep their defaults
 *                                       (Advanced tools OFF, time tracking OFF)
 *   signUp(db, …)                       public: honeypot → Zod → rate limit (Postgres) → bcrypt (always, so a
 *                                       taken email costs the same time) → both steps above in ONE transaction,
 *                                       cause "signup"; a pending invitee's address is told to use the invite link
 *
 * The demo seed (src/db/seed/org.ts) and sign-up call the same two functions, so a real studio and the demo
 * studio are built the same way.
 */
import { eq } from "drizzle-orm";
import { isUniqueViolation } from "@/db/errors";
import { first, getDb, one, type Db, type DbLike, type Tx } from "@/db/index";
import { organisationSettings, organisations, users } from "@/db/schema";
import {
  AVATAR_PALETTE,
  DEFAULT_JOB_TYPES,
  DEFAULT_TIMEZONE,
  DEFAULT_USUAL_DAYS_BY_JOB_TYPE,
  DEFAULT_WORKFLOW_NAME,
  SIGNUP_HONEYPOT_FIELD,
  SLUG_FALLBACK,
  SLUG_MAX_LENGTH,
  type EventCause,
  type Role,
} from "@/lib/constants";
import { slugify } from "@/lib/utils";
import type { AuthContext } from "@/lib/types";
import { EmailSchema, SignUpInput } from "@/lib/validation/auth";
import { recordEvent } from "@/server/audit";
import { hashPassword } from "@/server/auth/password";
import { signupKey } from "@/server/auth/db-rate-limit";
import { buildContextFromDb } from "@/server/auth/session";
import { issueSessionCookie } from "@/server/auth/sign-in";
import { nowIso } from "@/server/clock";
import { ValidationError } from "@/server/errors";
import { enforceLimit } from "./authLimits";
import { createJobType } from "./jobTypes";
import { createWorkflow, type WorkflowGraph } from "./workflows";
import { parseInput, withTx } from "./_shared";

/** One message for a taken address (names neither the studio nor the role; same timing as a fresh one). */
export const EMAIL_IN_USE_MESSAGE = "That email is already in use. Try signing in.";

/**
 * The address belongs to someone who was invited but has not opened their link yet: signing in cannot work for
 * them, so say what will. Never names the studio.
 */
export const PENDING_INVITE_MESSAGE = "This email has been invited to a studio. Use the invite link in your email, or ask the studio to send it again.";

/** The one answer a filled-in honeypot gets (a bot learns nothing from it; a person never sees it). */
export const SIGNUP_REFUSED_MESSAGE = "Something went wrong. Please try again.";

/* ------------------------------------------------------------------ */
/*  Slugs                                                              */
/* ------------------------------------------------------------------ */

/** `slugify(name)` trimmed to SLUG_MAX_LENGTH (no dangling hyphen), or "studio" when nothing is left. */
export function slugBase(name: string): string {
  const base = slugify(name).slice(0, SLUG_MAX_LENGTH).replace(/-+$/g, "");
  return base.length > 0 ? base : SLUG_FALLBACK;
}

/** `base`, or `base-2`, `base-3`, … — the first slug no organisation uses yet. */
export async function uniqueSlug(db: DbLike, requested: string): Promise<string> {
  const base = slugBase(requested);
  const taken = new Set((await db.select({ slug: organisations.slug }).from(organisations)).map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10_000; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("uniqueSlug: no free slug");
}

/* ------------------------------------------------------------------ */
/*  Organisation + owner                                               */
/* ------------------------------------------------------------------ */

export interface OwnerDef {
  name: string;
  email: string;
  /** bcrypt hash of the owner's password (computed outside the transaction); Google sign-up: `unusablePasswordHash()`. */
  passwordHash: string;
  title?: string | null;
  avatarColour?: string;
  /** Accounts: false for a Google-only owner (no password). Default true. */
  hasPassword?: boolean;
  /** Accounts: when the owner's email was confirmed (Google sign-up: now). Default null (not confirmed). */
  emailVerifiedAt?: string | null;
  /** Accounts: the Google account the owner signs in with (Google sign-up). Set both or neither. */
  googleSub?: string | null;
  googleEmail?: string | null;
}

export interface CreateOrganisationWithOwnerInput {
  name: string;
  /** Requested slug (defaults to slugify(name)); a numeric suffix is added when taken. */
  slug?: string;
  timezone?: string;
  owner: OwnerDef;
  /** `metadata.cause` of the two events (sign-up: "signup"; seed: "seed"). Default "user". */
  cause?: EventCause;
  /** Accounts: the seeded demo studio (`organisations.is_demo`). Only the seed sets it. Default false. */
  isDemo?: boolean;
  requestId?: string;
  /** Clock (defaults to the injectable clock through the owner's context). */
  now?: () => string;
}

export interface CreatedOrganisation {
  organisationId: string;
  ownerId: string;
  slug: string;
  /** The owner's context inside the same transaction (for the structure bootstrap that follows). */
  ctx: AuthContext;
}

/**
 * Inserts the organisation, its settings row (column defaults: Advanced tools off, time tracking off,
 * timezone as given) and the first owner: role photographer, `is_admin`, every member switch on,
 * `accepted_at = now` (they chose their password), primary owner (trigger `org_primary_owner`).
 * Audits `org.created` and `user.created` as the owner (metadata `bootstrap: true, primaryOwner: true`).
 */
export async function createOrganisationWithOwner(tx: Tx, input: CreateOrganisationWithOwnerInput): Promise<CreatedOrganisation> {
  const slug = await uniqueSlug(tx, input.slug ?? input.name);
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;
  const requestId = input.requestId;
  const cause: EventCause = input.cause ?? "user";
  // The rows written before the owner's context exists use the same clock the context will.
  const at = (input.now ?? nowIso)();

  const org = await one(
    tx
      .insert(organisations)
      .values({ name: input.name, slug, isDemo: input.isDemo ?? false, createdAt: at, updatedAt: at })
      .returning({ id: organisations.id, slug: organisations.slug }),
    "organisation",
  );
  await tx.insert(organisationSettings).values({ organisationId: org.id, timezone, updatedAt: at });
  const owner = await one(
    tx
      .insert(users)
      .values({
        organisationId: org.id,
        email: input.owner.email,
        passwordHash: input.owner.passwordHash,
        name: input.owner.name,
        role: "photographer",
        isAdmin: true,
        canCreateJobs: true,
        canViewAllJobs: true,
        canAssignEditors: true,
        canReviewSubmissions: true,
        canViewTeamWorkloads: true,
        canViewAnalytics: true,
        canViewTeamJobs: false,
        title: input.owner.title ?? null,
        avatarColour: input.owner.avatarColour ?? AVATAR_PALETTE[Math.floor(Date.parse(at) / 1000) % AVATAR_PALETTE.length],
        isActive: true,
        acceptedAt: at,
        hasPassword: input.owner.hasPassword ?? true,
        emailVerifiedAt: input.owner.emailVerifiedAt ?? null,
        googleSub: input.owner.googleSub ?? null,
        googleEmail: input.owner.googleEmail ?? null,
        createdAt: at,
        updatedAt: at,
      })
      .returning({ id: users.id }),
    "owner",
  );
  await tx.update(organisationSettings).set({ primaryOwnerUserId: owner.id }).where(eq(organisationSettings.organisationId, org.id));

  const ctx = await buildContextFromDb(tx, owner.id, { cause, ...(requestId ? { requestId } : {}), ...(input.now ? { now: input.now } : {}) });
  if (!ctx) throw new Error("createOrganisationWithOwner: the new owner has no context");
  await recordEvent(tx, ctx, {
    entityType: "organisation",
    entityId: org.id,
    eventType: "org.created",
    action: "created",
    previousValue: null,
    newValue: { name: input.name, slug: org.slug, timezone, ...(input.isDemo ? { isDemo: true } : {}) },
    metadata: { organisationId: org.id, ownerUserId: owner.id, ...(input.owner.googleSub ? { via: "google" } : {}) },
    visibility: "management",
  });
  await recordEvent(tx, ctx, {
    entityType: "user",
    entityId: owner.id,
    eventType: "user.created",
    action: "created",
    previousValue: null,
    newValue: { name: input.owner.name, email: input.owner.email, role: "photographer" satisfies Role, isAdmin: true, title: input.owner.title ?? null },
    metadata: { targetUserId: owner.id, bootstrap: true, primaryOwner: true },
  });
  return { organisationId: org.id, ownerId: owner.id, slug: org.slug, ctx };
}

/* ------------------------------------------------------------------ */
/*  Structure bootstrap                                                */
/* ------------------------------------------------------------------ */

export interface BootstrapOrganisationInput {
  organisationId: string;
  ownerUserId: string;
  /**
   * "Usual days to edit" per type of shoot. Omitted → DEFAULT_USUAL_DAYS_BY_JOB_TYPE; `null` → none set
   * (the full demo fixture keeps the pre-front-door shape).
   */
  usualDays?: Readonly<Record<string, number>> | null;
  cause?: EventCause;
  requestId?: string;
  now?: () => string;
  /** Reuse a context built in this transaction (createOrganisationWithOwner returns one). */
  ctx?: AuthContext;
}

export interface BootstrapResult {
  workflow: WorkflowGraph;
  /** status key → id of the default workflow. */
  statuses: Record<string, string>;
  /** job type name → id. */
  jobTypes: Record<string, string>;
}

/**
 * Builds the structure every studio starts with, as the owner, through the admin services (each step is its
 * own audited event): the default workflow made the organisation default, and the default types of shoot.
 * Requires the owner to be an active admin of the organisation (the settings row's primary owner is set when
 * still null). Idempotency is NOT attempted: call it once, right after createOrganisationWithOwner.
 */
export async function bootstrapOrganisation(tx: Tx, input: BootstrapOrganisationInput): Promise<BootstrapResult> {
  const settings = await first(tx.select({ primaryOwnerUserId: organisationSettings.primaryOwnerUserId }).from(organisationSettings).where(eq(organisationSettings.organisationId, input.organisationId)));
  if (!settings) throw new Error("bootstrapOrganisation: the organisation has no settings row");
  if (settings.primaryOwnerUserId === null) {
    await tx.update(organisationSettings).set({ primaryOwnerUserId: input.ownerUserId }).where(eq(organisationSettings.organisationId, input.organisationId));
  }
  const ctx =
    input.ctx ??
    (await buildContextFromDb(tx, input.ownerUserId, {
      cause: input.cause ?? "user",
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.now ? { now: input.now } : {}),
    }));
  if (!ctx || ctx.organisationId !== input.organisationId || !ctx.isAdmin) {
    throw new Error("bootstrapOrganisation: the owner must be an active admin of the organisation");
  }

  const workflow = await createWorkflow(tx, ctx, { name: DEFAULT_WORKFLOW_NAME, description: "Shoot, edit, review, deliver.", from: "default", isDefault: true });
  const statuses: Record<string, string> = {};
  for (const s of workflow.statuses) if (!s.archivedAt) statuses[s.key] = s.id;

  const usualDays = input.usualDays === undefined ? DEFAULT_USUAL_DAYS_BY_JOB_TYPE : input.usualDays;
  const jobTypes: Record<string, string> = {};
  for (const [i, jt] of DEFAULT_JOB_TYPES.entries()) {
    const days = usualDays?.[jt.name];
    const row = await createJobType(tx, ctx, {
      name: jt.name,
      colour: jt.colour,
      workflowId: workflow.workflow.id,
      defaultEstimatedHours: jt.defaultEstimatedHours,
      ...(days !== undefined ? { usualDaysToEdit: days } : {}),
      sortOrder: i,
    });
    jobTypes[jt.name] = row.id;
  }
  return { workflow, statuses, jobTypes };
}

/* ------------------------------------------------------------------ */
/*  Sign-up                                                            */
/* ------------------------------------------------------------------ */

export interface SignUpResult {
  organisationId: string;
  slug: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
  sessionVersion: number;
}

function emailInUse(): ValidationError {
  return new ValidationError(EMAIL_IN_USE_MESSAGE, { formErrors: [], fieldErrors: { email: [EMAIL_IN_USE_MESSAGE] } });
}

function pendingInvite(): ValidationError {
  return new ValidationError(PENDING_INVITE_MESSAGE, { formErrors: [], fieldErrors: { email: [PENDING_INVITE_MESSAGE] } });
}

/** The generic 400 a filled-in honeypot gets: no field errors, nothing that says why. */
function signupRefused(): ValidationError {
  return new ValidationError(SIGNUP_REFUSED_MESSAGE, { formErrors: [SIGNUP_REFUSED_MESSAGE], fieldErrors: {} });
}

/** Is this (normalised) address already a user of any studio, in any role? (Google sign-up re-uses it.) */
export async function emailTaken(db: DbLike, email: string): Promise<boolean> {
  return (await first(db.select({ id: users.id }).from(users).where(eq(users.email, email)))) !== undefined;
}

/** How an address is used: free, an invite nobody has opened yet (active, not accepted, not anonymised), or taken. */
export type EmailUse = "free" | "pending_invite" | "taken";

export async function emailUse(db: DbLike, email: string): Promise<EmailUse> {
  const row = await first(
    db.select({ isActive: users.isActive, acceptedAt: users.acceptedAt, anonymisedAt: users.anonymisedAt }).from(users).where(eq(users.email, email)),
  );
  if (!row) return "free";
  return row.isActive && row.acceptedAt === null && row.anonymisedAt === null ? "pending_invite" : "taken";
}

/** The 400 for an address that is not free (the pending-invitee copy, or the usual "already in use"). */
export function emailUseMessage(use: Exclude<EmailUse, "free">): string {
  return use === "pending_invite" ? PENDING_INVITE_MESSAGE : EMAIL_IN_USE_MESSAGE;
}

/**
 * The sign-up honeypot (`SIGNUP_HONEYPOT_FIELD` = "website", a field people never see): filled when it carries
 * anything but an empty / blank string. Read from the RAW body, before validation, so a bot never gets field
 * errors to learn from.
 */
export function honeypotFilled(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const value = (raw as Record<string, unknown>)[SIGNUP_HONEYPOT_FIELD];
  if (value === undefined || value === null) return false;
  return typeof value !== "string" || value.trim().length > 0;
}

function rawString(raw: unknown, key: string): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = (raw as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/**
 * Zod first; when it fails, the email is still checked so a taken address and a short password come back in
 * the ONE 400 (two submits to learn two things was the front door's most-reported snag). That lookup answers
 * whether an address has an account, so it only runs AFTER `beforeLookup` (the sign-up rate limit, which counts the
 * attempt — SEC-04: without it the 400 was an unthrottled "is this address registered?" oracle). The success path
 * keeps its uniqueness check inside the transaction, where it matters for a race.
 */
async function parseSignUp(db: DbLike, raw: unknown, beforeLookup: (email: string) => Promise<unknown>): Promise<SignUpInput> {
  try {
    return parseInput(SignUpInput, raw);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    const details = err.details as { formErrors: string[]; fieldErrors: Record<string, string[]> };
    const email = raw && typeof raw === "object" ? EmailSchema.safeParse((raw as Record<string, unknown>).email) : null;
    if (email?.success && !details.fieldErrors.email) {
      await beforeLookup(email.data);
      const use = await emailUse(db, email.data);
      if (use !== "free") {
        const message = emailUseMessage(use);
        throw new ValidationError(message, { formErrors: details.formErrors, fieldErrors: { ...details.fieldErrors, email: [message] } });
      }
    }
    throw err;
  }
}

/**
 * Public "Create your studio" (no context): honeypot (filled → the generic 400, and the attempt still counts) → Zod
 * (password ≥ 10, email, studio name 2–80) → 5 sign-ups / hour / IP (Postgres-backed; every valid attempt counts;
 * 429 "Too many new studios from this network. Try again in N minutes.") → bcrypt the password BEFORE the
 * uniqueness check, so a taken address answers in the same time → in one transaction: organisation + settings +
 * owner + structure bootstrap, every event with cause "signup".
 * A taken email → 400 `validation` with `fieldErrors.email` = EMAIL_IN_USE_MESSAGE, or PENDING_INVITE_MESSAGE when it
 * belongs to an invite nobody has opened yet (checked up front AND mapped from the unique index, so a race gets the
 * same answer). No session is created here (see `signUpAndSignIn`).
 */
export async function signUp(db: Db, raw: unknown, opts: { requestId?: string } = {}): Promise<SignUpResult> {
  if (honeypotFilled(raw)) {
    // A bot: counted like any attempt (so it is throttled too), then the one generic answer.
    await enforceLimit(db, "signup", signupKey(rawString(raw, "ip"), rawString(raw, "email") ?? ""), "signup");
    throw signupRefused();
  }
  // A form with mistakes still learns whether its address is taken, but only within the sign-up limit (the attempt
  // counts, exactly like a valid one).
  const input = await parseSignUp(db, raw, (email) => enforceLimit(db, "signup", signupKey(rawString(raw, "ip"), email), "signup"));
  await enforceLimit(db, "signup", signupKey(input.ip, input.email), "signup");

  const passwordHash = await hashPassword(input.password);
  try {
    return await withTx(
      async (tx) => {
        const use = await emailUse(tx, input.email);
        if (use === "pending_invite") throw pendingInvite();
        if (use === "taken") throw emailInUse();
        const created = await createOrganisationWithOwner(tx, {
          name: input.studioName,
          timezone: input.timezone,
          owner: { name: input.ownerName, email: input.email, passwordHash },
          cause: "signup",
          requestId: opts.requestId,
        });
        await bootstrapOrganisation(tx, { organisationId: created.organisationId, ownerUserId: created.ownerId, ctx: created.ctx });
        // Sign-up signs the owner in, so People's "Last signed in" never reads "Never" for them.
        await tx.update(users).set({ lastLoginAt: created.ctx.now() }).where(eq(users.id, created.ownerId));
        const row = await one(tx.select({ sessionVersion: users.sessionVersion }).from(users).where(eq(users.id, created.ownerId)), "owner");
        return {
          organisationId: created.organisationId,
          slug: created.slug,
          userId: created.ownerId,
          name: input.ownerName,
          email: input.email,
          role: "photographer",
          sessionVersion: row.sessionVersion,
        };
      },
      { db },
    );
  } catch (err) {
    if (isUniqueViolation(err, "users_email_uq")) throw emailInUse();
    throw err;
  }
}

/** Sign-up + the session cookie (route handlers). The owner lands on /home. */
export async function signUpAndSignIn(raw: unknown, opts: { requestId?: string; db?: Db } = {}): Promise<SignUpResult> {
  const result = await signUp(opts.db ?? getDb(), raw, opts);
  await issueSessionCookie({ id: result.userId, role: result.role, sessionVersion: result.sessionVersion, email: result.email });
  return result;
}
