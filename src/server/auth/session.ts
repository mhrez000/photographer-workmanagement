/**
 * Sessions (ARCHITECTURE.md §3.3).
 *
 * Stateless jose HS256 cookie `pwm_session` carrying `{ sub, sv, k }`
 * (user id + session version + kind "staff" | "client", docs/ROLES.md §7.8;
 * `k` is a routing hint for the proxy only). Every request re-reads the user
 * row: inactive users, stale `sessionVersion`s (bumped on deactivate, role
 * change, password change) and client users whose client is archived or has
 * the portal off get no context → 401. `SESSION_SECRET` (≥ 32
 * chars) is required in production; the module throws at load time without
 * it. Local dev falls back to a generated data/.session-secret (devSecret).
 *
 * Context builders:
 *   - `await buildContextFromDb(db, userId, opts)` — pure DB → AuthContext (tests use it)
 *   - `requireContext()` — STAFF only (asserts `app.access`: a client gets 403)
 *   - `requirePortalContext()` — clients only (asserts `portal.access`)
 *   - `requireAnyContext()` — any signed-in user (/api/auth/me|logout|change-password only)
 *   - `getOptionalContext()` — cookie → AuthContext or null, cached per request
 *   - `await systemContext(orgId, { db: tx, … })` — automations / sweep / seed (isSystem, userId null);
 *     inside a transaction ALWAYS pass `db: tx` (it reads organisation_settings)
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cache } from "react";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { and, eq, isNull, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, type DbLike } from "@/db/index";
import { clients, organisationSettings, organisations, teamMemberships, teams, users } from "@/db/schema";
import {
  DEFAULT_TIMEZONE,
  PERSONA_LABELS,
  SESSION_COOKIE_NAME,
  SESSION_TTL_DAYS,
  personaOfUser,
  type EventCause,
  type Persona,
  type Role,
} from "@/lib/constants";
import type { AuthContext, ContextSettings, OrganisationSettings, SessionKind, SessionPayload, User } from "@/lib/types";
import { ForbiddenError, UnauthorizedError } from "@/server/errors";
import { nowIso } from "@/server/clock";
import { currentRequestId, newRequestId } from "@/server/request-scope";

/* ------------------------------------------------------------------ */
/*  Secret                                                             */
/* ------------------------------------------------------------------ */

export const SESSION_SECRET_MIN_LENGTH = 32;

/**
 * Fallback for builds without SESSION_SECRET: data/.session-secret (a random
 * per-deployment secret, never committed; traced into the server output by
 * next.config.ts). An explicit SESSION_SECRET always wins.
 */
function secretFilePath(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), "data/.session-secret");
}

function readBuildSecret(): string | undefined {
  try {
    return fs.readFileSync(secretFilePath(), "utf8").trim();
  } catch {
    return undefined;
  }
}

/**
 * Zero-config local development: outside production, with neither
 * SESSION_SECRET nor data/.session-secret, generate a random secret once and
 * keep it in data/.session-secret (gitignored) so sessions survive restarts.
 * Production never generates one: it must be configured.
 */
function devSecret(): string | undefined {
  if (process.env.NODE_ENV === "production") return undefined;
  try {
    const file = secretFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const secret = randomBytes(36).toString("base64url");
    // "wx": never overwrite a secret another process wrote first.
    fs.writeFileSync(file, `${secret}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return secret;
  } catch {
    return readBuildSecret();
  }
}

function loadSecret(): Uint8Array {
  const raw = process.env.SESSION_SECRET?.trim() || readBuildSecret() || devSecret();
  if (!raw || raw.length < SESSION_SECRET_MIN_LENGTH) {
    throw new Error(
      `SESSION_SECRET is missing or shorter than ${SESSION_SECRET_MIN_LENGTH} characters. Set it in .env (see .env.example).`,
    );
  }
  return new TextEncoder().encode(raw);
}

const secretKey = loadSecret();
const SESSION_TTL_SECONDS = SESSION_TTL_DAYS * 24 * 60 * 60;

/* ------------------------------------------------------------------ */
/*  Tokens (pure; testable without a request)                          */
/* ------------------------------------------------------------------ */

/** Session kind for a role (claim `k`). */
export function sessionKindForRole(role: Role): SessionKind {
  return role === "client" ? "client" : "staff";
}

export async function signSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ sv: payload.sv, ...(payload.k ? { k: payload.k } : {}), ...(payload.r ? { r: payload.r } : {}) })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey);
}

/** Verifies signature + expiry; returns null for anything invalid. */
export async function verifySessionToken(token: string | null | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey, { algorithms: ["HS256"] });
    const sv = payload.sv;
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    if (typeof sv !== "number" || !Number.isInteger(sv)) return null;
    const k = payload.k === "client" ? "client" : "staff";
    const r = payload.r === "editor" || payload.r === "client" || payload.r === "photographer" ? payload.r : undefined;
    return { sub: payload.sub, sv, k, ...(r ? { r } : {}) };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Cookie                                                             */
/* ------------------------------------------------------------------ */

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

/**
 * Sets the session cookie (route handlers / server actions only). `kind` defaults to staff; `role` is
 * the optional landing hint (`r` claim) the proxy uses to send editors to /my-jobs.
 */
export async function createSession(userId: string, sessionVersion: number, kind: SessionKind = "staff", role?: Role): Promise<void> {
  const token = await signSessionToken({ sub: userId, sv: sessionVersion, k: kind, ...(role ? { r: role } : {}) });
  const jar = await cookies();
  jar.set(SESSION_COOKIE_NAME, token, cookieOptions(SESSION_TTL_SECONDS));
}

/** Expires the session cookie (route handlers / server actions only). */
export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE_NAME, "", cookieOptions(0));
}

/** Reads + verifies the cookie of the current request. */
export async function readSessionToken(): Promise<SessionPayload | null> {
  const jar = await cookies();
  return verifySessionToken(jar.get(SESSION_COOKIE_NAME)?.value);
}

/* ------------------------------------------------------------------ */
/*  Context building                                                   */
/* ------------------------------------------------------------------ */

const DEFAULT_SETTINGS: ContextSettings = {
  timezone: DEFAULT_TIMEZONE,
  timeTrackingEnabled: false,
  automationsEnabled: true,
  auditNotifications: false,
};

/** The context's copy of organisation_settings (roles v2: no org-wide visibility switches). */
export function settingsToContext(row: OrganisationSettings | undefined): ContextSettings {
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    timezone: row.timezone,
    timeTrackingEnabled: row.timeTrackingEnabled,
    automationsEnabled: row.automationsEnabled,
    auditNotifications: row.auditNotifications,
    advancedToolsEnabled: row.advancedToolsEnabled,
  };
}

async function loadSettingsRow(db: DbLike, organisationId: string): Promise<OrganisationSettings | undefined> {
  const [row] = await db.select().from(organisationSettings).where(eq(organisationSettings.organisationId, organisationId)).limit(1);
  return row;
}

async function loadSettings(db: DbLike, organisationId: string): Promise<ContextSettings> {
  return settingsToContext(await loadSettingsRow(db, organisationId));
}

/** The switches a context carries: EFFECTIVE values (docs/ROLES.md §2.1). */
export type EffectiveFlags = Pick<
  AuthContext,
  | "canCreateJobs"
  | "canViewAllJobs"
  | "canAssignEditors"
  | "canReviewSubmissions"
  | "canViewTeamWorkloads"
  | "canViewAnalytics"
  | "canViewTeamJobs"
>;

/**
 * Raw user columns → effective switches. Admin ⇒ every member switch; a switch
 * outside its role is false; clients have none. Admins keep their stored member
 * switches in the row (revoking admin restores them) but they are ignored here.
 */
export function effectiveFlags(user: Pick<
  User,
  | "role"
  | "isAdmin"
  | "canCreateJobs"
  | "canViewAllJobs"
  | "canAssignEditors"
  | "canReviewSubmissions"
  | "canViewTeamWorkloads"
  | "canViewAnalytics"
  | "canViewTeamJobs"
>): EffectiveFlags {
  const admin = user.role === "photographer" && user.isAdmin;
  const member = user.role === "photographer" && !user.isAdmin;
  const editor = user.role === "editor";
  return {
    canCreateJobs: admin || ((member || editor) && user.canCreateJobs),
    canViewAllJobs: admin || (member && user.canViewAllJobs),
    canAssignEditors: admin || (member && user.canAssignEditors),
    canReviewSubmissions: admin || (member && user.canReviewSubmissions),
    canViewTeamWorkloads: admin || (member && user.canViewTeamWorkloads),
    canViewAnalytics: admin || (member && user.canViewAnalytics),
    canViewTeamJobs: editor && user.canViewTeamJobs,
  };
}

interface ClientAccess {
  clientName: string;
  feedbackEnabled: boolean;
}

/** A client user's client, when it still grants portal access (in org, not archived, portal on). */
async function loadClientAccess(db: DbLike, user: User): Promise<ClientAccess | null> {
  if (user.role !== "client" || !user.clientId) return null;
  const [row] = await db
    .select({ name: clients.name, portalEnabled: clients.portalEnabled, feedbackEnabled: clients.feedbackEnabled, archivedAt: clients.archivedAt })
    .from(clients)
    .where(and(eq(clients.id, user.clientId), eq(clients.organisationId, user.organisationId)))
    .limit(1);
  if (!row || !row.portalEnabled || row.archivedAt !== null) return null;
  return { clientName: row.name, feedbackEnabled: row.feedbackEnabled };
}

/**
 * Users sharing an active membership (left_at IS NULL) in a non-archived team
 * with `userId`, excluding `userId` itself.
 */
export async function loadTeamUserIds(db: DbLike, organisationId: string, userId: string): Promise<Set<string>> {
  const mine = alias(teamMemberships, "mine");
  const rows = await db
    .selectDistinct({ userId: teamMemberships.userId })
    .from(mine)
    .innerJoin(teams, and(eq(teams.id, mine.teamId), isNull(teams.archivedAt)))
    .innerJoin(teamMemberships, and(eq(teamMemberships.teamId, mine.teamId), isNull(teamMemberships.leftAt)))
    .where(
      and(
        eq(mine.organisationId, organisationId),
        eq(mine.userId, userId),
        isNull(mine.leftAt),
        ne(teamMemberships.userId, userId),
      ),
    );
  return new Set(rows.map((r) => r.userId));
}

export interface BuildContextOptions {
  /** When given, a mismatch with users.session_version yields null (stale cookie). */
  sessionVersion?: number;
  requestId?: string;
  /** Clock override; defaults to the injectable clock (src/server/clock.ts). */
  now?: () => string;
  cause?: EventCause;
}

interface UserContext {
  ctx: AuthContext;
  client: ClientAccess | null;
}

/** Null for a client user whose client no longer grants portal access (like a deactivated user). */
async function contextFromUser(db: DbLike, user: User, opts: BuildContextOptions): Promise<UserContext | null> {
  // Sequential on purpose: `db` may be a transaction (one connection).
  const client = await loadClientAccess(db, user);
  if (user.role === "client" && !client) return null;
  const teamUserIds = user.role === "client" ? new Set<string>() : await loadTeamUserIds(db, user.organisationId, user.id);
  const settingsRow = await loadSettingsRow(db, user.organisationId);
  const isAdmin = user.role === "photographer" && user.isAdmin;
  return {
    client,
    ctx: {
      userId: user.id,
      organisationId: user.organisationId,
      role: user.role,
      isAdmin,
      isPrimaryOwner: isAdmin && settingsRow?.primaryOwnerUserId === user.id,
      isActive: user.isActive,
      ...effectiveFlags(user),
      clientId: user.role === "client" ? user.clientId : null,
      clientFeedbackEnabled: client?.feedbackEnabled ?? false,
      teamUserIds,
      settings: settingsToContext(settingsRow),
      isSystem: false,
      now: opts.now ?? nowIso,
      requestId: opts.requestId ?? currentRequestId() ?? newRequestId(),
      ...(opts.cause ? { cause: opts.cause } : {}),
    },
  };
}

/**
 * Loads the fresh user row + organisation settings + active teammates (+ the
 * client of a client user). Returns null when the user is missing, inactive,
 * anonymised, the session version does not match, or a client user's client
 * is archived / has the portal off.
 */
export async function buildContextFromDb(db: DbLike, userId: string, opts: BuildContextOptions = {}): Promise<AuthContext | null> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || !user.isActive || user.anonymisedAt) return null;
  if (opts.sessionVersion !== undefined && user.sessionVersion !== opts.sessionVersion) return null;
  return (await contextFromUser(db, user, opts))?.ctx ?? null;
}

/** `buildContextFromDb` against the app database (`getDb()`). */
export async function buildContext(userId: string, requestId?: string, sessionVersion?: number): Promise<AuthContext | null> {
  return buildContextFromDb(getDb(), userId, { requestId, sessionVersion });
}

export interface SystemContextOptions {
  requestId?: string;
  now?: () => string;
  /** Defaults to "sweep" (or "automation" when automationRunId is set). */
  cause?: EventCause;
  automationRunId?: string | null;
  /** Where to read the organisation settings. Inside a transaction pass the `tx` (default `getDb()`). */
  db?: DbLike;
}

/**
 * Context for automations / sweep / seed: `isSystem = true`, `userId = null`,
 * admin-equivalent (role photographer, isAdmin, every switch). permissions.ts
 * restricts it to the automation action allowlist; events it writes have
 * `actor_user_id = null`.
 */
export async function systemContext(organisationId: string, opts: SystemContextOptions = {}): Promise<AuthContext> {
  const db = opts.db ?? getDb();
  const role: Role = "photographer";
  const settings = await loadSettings(db, organisationId);
  return {
    userId: null,
    organisationId,
    role,
    isAdmin: true,
    isPrimaryOwner: false,
    isActive: true,
    canCreateJobs: true,
    canViewAllJobs: true,
    canAssignEditors: true,
    canReviewSubmissions: true,
    canViewTeamWorkloads: true,
    canViewAnalytics: true,
    canViewTeamJobs: false,
    clientId: null,
    clientFeedbackEnabled: false,
    teamUserIds: new Set<string>(),
    settings,
    isSystem: true,
    now: opts.now ?? nowIso,
    requestId: opts.requestId ?? currentRequestId() ?? newRequestId(),
    cause: opts.cause ?? (opts.automationRunId ? "automation" : "sweep"),
    automationRunId: opts.automationRunId ?? null,
  };
}

/* ------------------------------------------------------------------ */
/*  Per-request resolution (cookie → context), cached with React cache */
/* ------------------------------------------------------------------ */

/** What the app chrome (staff shell or portal header) needs about the signed-in user. */
export interface Viewer {
  id: string;
  name: string;
  email: string;
  role: Role;
  isAdmin: boolean;
  isPrimaryOwner: boolean;
  persona: Persona;
  /** "Owner / Photographer", "Photographer (team member)", "Editor", "Client". */
  personaLabel: string;
  avatarColour: string;
  title: string | null;
  organisationId: string;
  organisationName: string;
  /** Client users only. */
  clientId: string | null;
  clientName: string | null;
}

interface ResolvedSession {
  ctx: AuthContext;
  viewer: Viewer;
}

const resolveSession = cache(async (): Promise<ResolvedSession | null> => {
  const payload = await readSessionToken();
  if (!payload) return null;
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, payload.sub)).limit(1);
  if (!user || !user.isActive || user.anonymisedAt || user.sessionVersion !== payload.sv) return null;
  const resolved = await contextFromUser(db, user, {});
  if (!resolved) return null;
  const { ctx, client } = resolved;
  const [org] = await db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, user.organisationId)).limit(1);
  const persona = personaOfUser(user);
  return {
    ctx,
    viewer: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      isAdmin: ctx.isAdmin,
      isPrimaryOwner: ctx.isPrimaryOwner,
      persona,
      personaLabel: PERSONA_LABELS[persona],
      avatarColour: user.avatarColour,
      title: user.title,
      organisationId: user.organisationId,
      organisationName: org?.name ?? "",
      clientId: ctx.clientId,
      clientName: client?.clientName ?? null,
    },
  };
});

/** The current request's context (staff or client), or null when signed out / revoked. */
export async function getOptionalContext(): Promise<AuthContext | null> {
  return (await resolveSession())?.ctx ?? null;
}

/** Message of the 403 a client gets from any staff API / page / action. */
export const STAFF_ONLY_MESSAGE = "This area is for studio staff";

/**
 * The current request's STAFF context. 401 when signed out; 403 for a client
 * user (`app.access`, docs/ROLES.md §3.1). Every staff API route, server action
 * and staff route handler outside /api goes through this.
 */
export async function requireContext(): Promise<AuthContext> {
  const session = await resolveSession();
  if (!session) throw new UnauthorizedError();
  if (session.ctx.role === "client") throw new ForbiddenError("app.access", STAFF_ONLY_MESSAGE);
  return session.ctx;
}

/** The current request's CLIENT context (`portal.access`): 401 signed out, 403 for staff. Every /api/portal/** route. */
export async function requirePortalContext(): Promise<AuthContext> {
  const session = await resolveSession();
  if (!session) throw new UnauthorizedError();
  if (session.ctx.role !== "client") throw new ForbiddenError("portal.access", "This area is for clients");
  return session.ctx;
}

/** Any signed-in user (staff or client). Only /api/auth/me, /api/auth/logout, /api/auth/change-password. */
export async function requireAnyContext(): Promise<AuthContext> {
  const session = await resolveSession();
  if (!session) throw new UnauthorizedError();
  return session.ctx;
}

/** Signed-in user summary for the shell; null when signed out. */
export async function getViewer(): Promise<Viewer | null> {
  return (await resolveSession())?.viewer ?? null;
}
