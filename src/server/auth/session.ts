/**
 * Sessions (ARCHITECTURE.md §3.3).
 *
 * Stateless jose HS256 cookie `pwm_session` carrying only `{ sub, sv }`
 * (user id + session version). Every request re-reads the user row:
 * inactive users and stale `sessionVersion`s (bumped on deactivate, role
 * change, password change) get no context → 401. `SESSION_SECRET` (≥ 32
 * chars) is required; the module throws at load time without it.
 *
 * Context builders:
 *   - `buildContextFromDb(db, userId, opts)` — pure DB → AuthContext (tests use it)
 *   - `requireContext()` / `getOptionalContext()` — cookie → AuthContext, cached per request
 *   - `systemContext(orgId, opts)` — automations / sweep / seed (isSystem, userId null)
 */
import fs from "node:fs";
import path from "node:path";
import { cache } from "react";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { and, eq, isNull, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { getDb, type DbLike } from "@/db/index";
import { organisationSettings, organisations, teamMemberships, teams, users } from "@/db/schema";
import { DEFAULT_TIMEZONE, SESSION_COOKIE_NAME, SESSION_TTL_DAYS, type EventCause, type Role } from "@/lib/constants";
import type { AuthContext, ContextSettings, OrganisationSettings, SessionPayload, User } from "@/lib/types";
import { UnauthorizedError } from "@/server/errors";
import { nowIso } from "@/server/clock";
import { currentRequestId, newRequestId } from "@/server/request-scope";

/* ------------------------------------------------------------------ */
/*  Secret                                                             */
/* ------------------------------------------------------------------ */

export const SESSION_SECRET_MIN_LENGTH = 32;

/**
 * Fallback for hosted demo builds: scripts/build-demo-db.mjs writes a random
 * per-deployment secret to data/.session-secret when SESSION_SECRET is not
 * configured (never committed). An explicit SESSION_SECRET always wins.
 */
function readBuildSecret(): string | undefined {
  try {
    return fs.readFileSync(path.resolve(/*turbopackIgnore: true*/ process.cwd(), "data/.session-secret"), "utf8").trim();
  } catch {
    return undefined;
  }
}

function loadSecret(): Uint8Array {
  const raw = process.env.SESSION_SECRET?.trim() || readBuildSecret();
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

export async function signSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ sv: payload.sv })
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
    return { sub: payload.sub, sv };
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

/** Sets the session cookie (route handlers / server actions only). */
export async function createSession(userId: string, sessionVersion: number): Promise<void> {
  const token = await signSessionToken({ sub: userId, sv: sessionVersion });
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
  photographersSeeAllJobs: false,
  photographersSeeTeamJobs: true,
  editorsSeeTeamJobs: false,
  editorsSeeTeamWorkloads: false,
  automationsEnabled: true,
  auditNotifications: false,
};

export function settingsToContext(row: OrganisationSettings | undefined): ContextSettings {
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    timezone: row.timezone,
    timeTrackingEnabled: row.timeTrackingEnabled,
    photographersSeeAllJobs: row.photographersSeeAllJobs,
    photographersSeeTeamJobs: row.photographersSeeTeamJobs,
    editorsSeeTeamJobs: row.editorsSeeTeamJobs,
    editorsSeeTeamWorkloads: row.editorsSeeTeamWorkloads,
    automationsEnabled: row.automationsEnabled,
    auditNotifications: row.auditNotifications,
  };
}

function loadSettings(db: DbLike, organisationId: string): ContextSettings {
  const row = db.select().from(organisationSettings).where(eq(organisationSettings.organisationId, organisationId)).get();
  return settingsToContext(row);
}

/**
 * Users sharing an active membership (left_at IS NULL) in a non-archived team
 * with `userId`, excluding `userId` itself.
 */
export function loadTeamUserIds(db: DbLike, organisationId: string, userId: string): Set<string> {
  const mine = alias(teamMemberships, "mine");
  const rows = db
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
    )
    .all();
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

function contextFromUser(db: DbLike, user: User, opts: BuildContextOptions): AuthContext {
  return {
    userId: user.id,
    organisationId: user.organisationId,
    role: user.role,
    isActive: user.isActive,
    canViewTeamWorkloads: user.canViewTeamWorkloads,
    canViewAnalytics: user.canViewAnalytics,
    teamUserIds: loadTeamUserIds(db, user.organisationId, user.id),
    settings: loadSettings(db, user.organisationId),
    isSystem: false,
    now: opts.now ?? nowIso,
    requestId: opts.requestId ?? currentRequestId() ?? newRequestId(),
    ...(opts.cause ? { cause: opts.cause } : {}),
  };
}

/**
 * Loads the fresh user row + organisation settings + active teammates.
 * Returns null when the user is missing, inactive, anonymised, or the
 * session version does not match.
 */
export function buildContextFromDb(db: DbLike, userId: string, opts: BuildContextOptions = {}): AuthContext | null {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || !user.isActive || user.anonymisedAt) return null;
  if (opts.sessionVersion !== undefined && user.sessionVersion !== opts.sessionVersion) return null;
  return contextFromUser(db, user, opts);
}

/** `buildContextFromDb` against the app database (`getDb()`). */
export function buildContext(userId: string, requestId?: string, sessionVersion?: number): AuthContext | null {
  return buildContextFromDb(getDb(), userId, { requestId, sessionVersion });
}

export interface SystemContextOptions {
  requestId?: string;
  now?: () => string;
  /** Defaults to "sweep" (or "automation" when automationRunId is set). */
  cause?: EventCause;
  automationRunId?: string | null;
  db?: DbLike;
}

/**
 * Context for automations / sweep / seed: `isSystem = true`, `userId = null`,
 * owner-equivalent role. permissions.ts restricts it to the automation
 * action allowlist; events it writes have `actor_user_id = null`.
 */
export function systemContext(organisationId: string, opts: SystemContextOptions = {}): AuthContext {
  const db = opts.db ?? getDb();
  const role: Role = "owner";
  return {
    userId: null,
    organisationId,
    role,
    isActive: true,
    canViewTeamWorkloads: true,
    canViewAnalytics: true,
    teamUserIds: new Set<string>(),
    settings: loadSettings(db, organisationId),
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

/** What the app chrome needs about the signed-in user. */
export interface Viewer {
  id: string;
  name: string;
  email: string;
  role: Role;
  avatarColour: string;
  title: string | null;
  organisationId: string;
  organisationName: string;
}

interface ResolvedSession {
  ctx: AuthContext;
  viewer: Viewer;
}

const resolveSession = cache(async (): Promise<ResolvedSession | null> => {
  const payload = await readSessionToken();
  if (!payload) return null;
  const db = getDb();
  const user = db.select().from(users).where(eq(users.id, payload.sub)).get();
  if (!user || !user.isActive || user.anonymisedAt || user.sessionVersion !== payload.sv) return null;
  const org = db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, user.organisationId)).get();
  const ctx = contextFromUser(db, user, {});
  return {
    ctx,
    viewer: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      avatarColour: user.avatarColour,
      title: user.title,
      organisationId: user.organisationId,
      organisationName: org?.name ?? "",
    },
  };
});

/** The current request's context, or null when signed out / revoked. */
export async function getOptionalContext(): Promise<AuthContext | null> {
  return (await resolveSession())?.ctx ?? null;
}

/** The current request's context; throws UnauthorizedError (401) otherwise. */
export async function requireContext(): Promise<AuthContext> {
  const session = await resolveSession();
  if (!session) throw new UnauthorizedError();
  return session.ctx;
}

/** Signed-in user summary for the shell; null when signed out. */
export async function getViewer(): Promise<Viewer | null> {
  return (await resolveSession())?.viewer ?? null;
}
