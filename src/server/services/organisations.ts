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
 *   signUp(db, …)                       public: Zod → rate limit → bcrypt (always, so a taken email costs the
 *                                       same time) → both steps above in ONE transaction, cause "signup"
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
  SLUG_FALLBACK,
  SLUG_MAX_LENGTH,
  type EventCause,
  type Role,
} from "@/lib/constants";
import { slugify } from "@/lib/utils";
import type { AuthContext } from "@/lib/types";
import { SignUpInput } from "@/lib/validation/auth";
import { recordEvent } from "@/server/audit";
import { hashPassword } from "@/server/auth/password";
import { checkSignupAttempt, recordSignupAttempt } from "@/server/auth/rate-limit";
import { buildContextFromDb, createSession } from "@/server/auth/session";
import { nowIso } from "@/server/clock";
import { RateLimitedError, ValidationError } from "@/server/errors";
import { createJobType } from "./jobTypes";
import { createWorkflow, type WorkflowGraph } from "./workflows";
import { parseInput, withTx } from "./_shared";

/** One message for a taken address (names neither the studio nor the role; same timing as a fresh one). */
export const EMAIL_IN_USE_MESSAGE = "That email is already in use. Try signing in.";

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
  /** bcrypt hash of the owner's password (computed outside the transaction). */
  passwordHash: string;
  title?: string | null;
  avatarColour?: string;
}

export interface CreateOrganisationWithOwnerInput {
  name: string;
  /** Requested slug (defaults to slugify(name)); a numeric suffix is added when taken. */
  slug?: string;
  timezone?: string;
  owner: OwnerDef;
  /** `metadata.cause` of the two events (sign-up: "signup"; seed: "seed"). Default "user". */
  cause?: EventCause;
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
    tx.insert(organisations).values({ name: input.name, slug, createdAt: at, updatedAt: at }).returning({ id: organisations.id, slug: organisations.slug }),
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
    newValue: { name: input.name, slug: org.slug, timezone },
    metadata: { organisationId: org.id, ownerUserId: owner.id },
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

/**
 * Public "Create your studio" (no context): Zod (password ≥ 10, email, studio name 2–80) → 5 sign-ups / hour / IP
 * (429) → bcrypt the password BEFORE the uniqueness check, so a taken address answers in the same time → in one
 * transaction: organisation + settings + owner + structure bootstrap, every event with cause "signup".
 * A taken email → 400 `validation` with `fieldErrors.email` = EMAIL_IN_USE_MESSAGE (checked up front AND mapped
 * from the unique index, so a race gets the same answer). No session is created here (see `signUpAndSignIn`).
 */
export async function signUp(db: Db, raw: unknown, opts: { requestId?: string } = {}): Promise<SignUpResult> {
  const input = parseInput(SignUpInput, raw);
  const limit = checkSignupAttempt(input.ip, input.email);
  if (!limit.allowed) throw new RateLimitedError(limit.retryAfterSeconds);
  recordSignupAttempt(input.ip, input.email);

  const passwordHash = await hashPassword(input.password);
  try {
    return await withTx(
      async (tx) => {
        const taken = await first(tx.select({ id: users.id }).from(users).where(eq(users.email, input.email)));
        if (taken) throw emailInUse();
        const created = await createOrganisationWithOwner(tx, {
          name: input.studioName,
          timezone: input.timezone,
          owner: { name: input.ownerName, email: input.email, passwordHash },
          cause: "signup",
          requestId: opts.requestId,
        });
        await bootstrapOrganisation(tx, { organisationId: created.organisationId, ownerUserId: created.ownerId, ctx: created.ctx });
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
  await createSession(result.userId, result.sessionVersion, "staff", result.role);
  return result;
}
