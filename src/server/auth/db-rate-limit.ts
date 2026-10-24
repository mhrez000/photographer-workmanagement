/**
 * Postgres-backed sliding-window rate limits (docs/ACCOUNTS.md "Rate limits"; table `auth_rate_limits`).
 *
 * Replaces the process-local limiters of ./rate-limit.ts, which counted per serverless instance (on Vercel every
 * instance had its own empty memory, so the limits barely held). Same semantics:
 *
 *   - one row per COUNTED attempt: `(limiter, key_hash, hit_at, expires_at)`; `key_hash` = an HMAC of `limiter:key`
 *     keyed with the session secret (`keyedHash`, DATA-07), so no email address or IP is ever stored, and a copy of
 *     the table cannot confirm a guessed address either
 *   - `check` = how many rows of this (limiter, key) are newer than `now - window`; denied once `attempts` are in
 *     the window; `retryAfterSeconds` = when the oldest relevant hit leaves the window
 *   - `hit` records one attempt and returns the state AFTER it; `reset` deletes the key's rows (a successful login
 *     clears its email+IP key, never the per-email backstop)
 *   - single statements only (no session state, no advisory locks), so it works through the Supabase transaction
 *     pooler; two racing requests can both pass a check — a limit, not a lock
 *   - old rows are pruned opportunistically (`PRUNE_PROBABILITY` of hits deletes every expired row)
 *
 * Named limiters (`limiters.<name>`) follow RATE_LIMITS in src/lib/constants.ts; the table in
 * docs/ACCOUNTS-PLAN.md §2 says what each is keyed on. Services call `enforceRateLimit` (count every attempt) or
 * the login helpers (count failures only). Pass the db handle the service already has (a transaction works too,
 * but then the hit rolls back with it — call limiters OUTSIDE the transaction whose failure should still count).
 */
import { randomInt } from "node:crypto";
import { and, asc, count, desc, eq, gt, lt, min } from "drizzle-orm";
import type { DbLike } from "@/db/index";
import { authRateLimits } from "@/db/schema";
import { RATE_LIMITS, RATE_LIMITER_NAMES, type RateLimiterName, type RateLimitPolicy } from "@/lib/constants";
import { RateLimitedError } from "@/server/errors";
import { keyedHash } from "./session-token";

export interface RateLimitResult {
  allowed: boolean;
  /** Attempts still allowed inside the window. */
  remaining: number;
  /** Seconds until the oldest relevant attempt leaves the window (0 when allowed). */
  retryAfterSeconds: number;
}

/** One in this many hits also deletes every expired row (all limiters). */
export const PRUNE_EVERY_N_HITS = 50;

const iso = (ms: number) => new Date(ms).toISOString();

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** HMAC-SHA256 hex (session secret) of `limiter:key` — what `auth_rate_limits.key_hash` stores. */
export function rateLimitKeyHash(limiter: RateLimiterName, key: string): string {
  return keyedHash("rate-limit", `${limiter}:${key}`);
}

/* ------------------------------------------------------------------ */
/*  Keys                                                               */
/* ------------------------------------------------------------------ */

/** `email|ip` (lower-cased email; an unknown IP is "unknown") — login and forgot-password. */
export function emailIpKey(email: string, ip: string | null | undefined): string {
  return `${normaliseEmail(email)}|${ip?.trim() || "unknown"}`;
}

/** The normalised email alone — the IP-independent login backstop. */
export function emailKey(email: string): string {
  return normaliseEmail(email);
}

/**
 * `ip|<address>`, or `ip|unknown` when no client IP is known (no `TRUSTED_PROXY_COUNT`: every forwarding header is
 * ignored and the whole deployment shares that one bucket — set TRUSTED_PROXY_COUNT=1 on Vercel). Per-network limits
 * that must not become site-wide use `knownIpKey` instead.
 */
export function ipKey(ip: string | null | undefined): string {
  return `ip|${ip?.trim() || "unknown"}`;
}

/**
 * `ip|<address>`, or null when the client IP is unknown — then a per-network limit is SKIPPED rather than shared by
 * every visitor (SEC-10: one shared bucket lets any one person lock everybody out of demo sign-in / Google sign-in).
 */
export function knownIpKey(ip: string | null | undefined): string | null {
  const address = ip?.trim();
  return address ? `ip|${address}` : null;
}

/** `email|device:<id>` — failed sign-ins from one browser that has signed in to that address before (SEC-06). */
export function emailDeviceKey(email: string, deviceId: string): string {
  return `${normaliseEmail(email)}|device:${deviceId}`;
}

/** `user|<id>` — per-account limits (resend, email change, password checks). */
export function userKey(userId: string): string {
  return `user|${userId}`;
}

/**
 * Sign-ups are keyed by client IP. Without a known IP they fall back to the email address, so one deployment never
 * shares a single "unknown" bucket.
 */
export function signupKey(ip: string | null | undefined, email: string): string {
  const address = ip?.trim();
  return address ? `ip|${address}` : `email|${normaliseEmail(email)}`;
}

/* ------------------------------------------------------------------ */
/*  Limiter                                                            */
/* ------------------------------------------------------------------ */

export interface DbRateLimiterOptions {
  /** Test seam: 0 → never prune, 1 → prune on every hit. Default `1 / PRUNE_EVERY_N_HITS`. */
  pruneProbability?: number;
}

export class DbRateLimiter {
  readonly windowMs: number;
  readonly attempts: number;

  constructor(
    readonly name: RateLimiterName,
    readonly policy: RateLimitPolicy = RATE_LIMITS[name],
    private readonly options: DbRateLimiterOptions = {},
  ) {
    this.windowMs = policy.windowMinutes * 60_000;
    this.attempts = policy.attempts;
  }

  /** Is another attempt allowed for `key`? Does not record anything. */
  async check(db: DbLike, key: string, nowMs: number = Date.now()): Promise<RateLimitResult> {
    const keyHash = rateLimitKeyHash(this.name, key);
    const where = and(eq(authRateLimits.limiter, this.name), eq(authRateLimits.keyHash, keyHash), gt(authRateLimits.hitAt, iso(nowMs - this.windowMs)));
    const [row] = await db.select({ n: count(), oldest: min(authRateLimits.hitAt) }).from(authRateLimits).where(where);
    const n = Number(row?.n ?? 0);
    if (n < this.attempts) return { allowed: true, remaining: this.attempts - n, retryAfterSeconds: 0 };
    // The attempt that has to leave the window before another is allowed: the `attempts`-th most recent one.
    const recent = await db
      .select({ hitAt: authRateLimits.hitAt })
      .from(authRateLimits)
      .where(where)
      .orderBy(desc(authRateLimits.hitAt))
      .limit(this.attempts);
    const pivot = recent[recent.length - 1]?.hitAt ?? row?.oldest ?? iso(nowMs);
    const retryAfterMs = Date.parse(pivot) + this.windowMs - nowMs;
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }

  /** Records one attempt for `key` and returns the state AFTER it. */
  async hit(db: DbLike, key: string, nowMs: number = Date.now()): Promise<RateLimitResult> {
    await db.insert(authRateLimits).values({
      limiter: this.name,
      keyHash: rateLimitKeyHash(this.name, key),
      hitAt: iso(nowMs),
      expiresAt: iso(nowMs + this.windowMs),
    });
    const probability = this.options.pruneProbability ?? 1 / PRUNE_EVERY_N_HITS;
    if (probability > 0 && (probability >= 1 || randomInt(1_000_000) < probability * 1_000_000)) {
      await pruneRateLimits(db, nowMs);
    }
    return this.check(db, key, nowMs);
  }

  /** Forgets every attempt of `key` (e.g. the email+IP key after a successful login). */
  async reset(db: DbLike, key: string): Promise<void> {
    await db.delete(authRateLimits).where(and(eq(authRateLimits.limiter, this.name), eq(authRateLimits.keyHash, rateLimitKeyHash(this.name, key))));
  }

  /** Attempts recorded for `key` inside the window, oldest first (tests / diagnostics). */
  async hits(db: DbLike, key: string, nowMs: number = Date.now()): Promise<string[]> {
    const rows = await db
      .select({ hitAt: authRateLimits.hitAt })
      .from(authRateLimits)
      .where(and(eq(authRateLimits.limiter, this.name), eq(authRateLimits.keyHash, rateLimitKeyHash(this.name, key)), gt(authRateLimits.hitAt, iso(nowMs - this.windowMs))))
      .orderBy(asc(authRateLimits.hitAt));
    return rows.map((r) => r.hitAt);
  }
}

/** One limiter per RATE_LIMITS entry. */
export const limiters: Readonly<Record<RateLimiterName, DbRateLimiter>> = Object.fromEntries(
  RATE_LIMITER_NAMES.map((name) => [name, new DbRateLimiter(name)]),
) as Record<RateLimiterName, DbRateLimiter>;

/**
 * "Every attempt counts" limiters (sign-up, forgot-password, resend, email change, Google callback, demo sign-in):
 * throws `RateLimitedError` (429 + `retry-after`) when the key is over its limit, otherwise records this attempt.
 */
export async function enforceRateLimit(db: DbLike, name: RateLimiterName, key: string, nowMs: number = Date.now()): Promise<RateLimitResult> {
  const limiter = limiters[name];
  const before = await limiter.check(db, key, nowMs);
  if (!before.allowed) throw new RateLimitedError(before.retryAfterSeconds);
  return limiter.hit(db, key, nowMs);
}

/** Deletes every row past its window (all limiters). Returns how many were deleted. */
export async function pruneRateLimits(db: DbLike, nowMs: number = Date.now()): Promise<number> {
  const rows = await db.delete(authRateLimits).where(lt(authRateLimits.expiresAt, iso(nowMs))).returning({ id: authRateLimits.id });
  return rows.length;
}

/** Tests only: forgets every attempt of every limiter. */
export async function clearAllRateLimits(db: DbLike): Promise<void> {
  await db.delete(authRateLimits);
}

/* ------------------------------------------------------------------ */
/*  Login (failures only; every applicable limiter must allow)         */
/* ------------------------------------------------------------------ */

/**
 * Which counters a sign-in attempt is held to (SEC-06 / SEC-09):
 *   - an unknown browser: `login` (email + IP) AND the `loginEmail` backstop (email, any IP)
 *   - a browser that signed in to this address before (`deviceId`, src/server/auth/known-device.ts): only its own
 *     `loginDevice` key — the backstop strangers can fill never locks the owner out of their own browser
 *   - either way, `loginIp` (failures per client IP, any address) when the IP is known
 */
export interface LoginAttemptScope {
  deviceId?: string | null;
}

function loginKeys(email: string, ip: string | null | undefined, scope: LoginAttemptScope): [DbRateLimiter, string][] {
  const keys: [DbRateLimiter, string][] = scope.deviceId
    ? [[limiters.loginDevice, emailDeviceKey(email, scope.deviceId)]]
    : [
        [limiters.login, emailIpKey(email, ip)],
        [limiters.loginEmail, emailKey(email)],
      ];
  const network = knownIpKey(ip);
  if (network) keys.push([limiters.loginIp, network]);
  return keys;
}

/** The more restrictive of two results (denied wins; then the longer wait / fewer remaining). */
function strictest(a: RateLimitResult, b: RateLimitResult): RateLimitResult {
  if (a.allowed !== b.allowed) return a.allowed ? b : a;
  return {
    allowed: a.allowed,
    remaining: Math.min(a.remaining, b.remaining),
    retryAfterSeconds: Math.max(a.retryAfterSeconds, b.retryAfterSeconds),
  };
}

/** Is another login attempt for this email (from this IP / known browser) allowed under every limiter? Does not record. */
export async function checkLoginAttempt(
  db: DbLike,
  email: string,
  ip: string | null | undefined,
  nowMs?: number,
  scope: LoginAttemptScope = {},
): Promise<RateLimitResult> {
  const results: RateLimitResult[] = [];
  for (const [limiter, key] of loginKeys(email, ip, scope)) results.push(await limiter.check(db, key, nowMs));
  return results.reduce(strictest);
}

/** Records a failed attempt in every applicable limiter; returns the combined state after recording. */
export async function recordLoginAttemptFailure(
  db: DbLike,
  email: string,
  ip: string | null | undefined,
  nowMs?: number,
  scope: LoginAttemptScope = {},
): Promise<RateLimitResult> {
  const results: RateLimitResult[] = [];
  for (const [limiter, key] of loginKeys(email, ip, scope)) results.push(await limiter.hit(db, key, nowMs));
  return results.reduce(strictest);
}

/**
 * After a successful login: clear the email+IP key and this browser's own key (the per-email backstop and the
 * per-IP count drain with time only, so a victim's own sign-in cannot top an attacker back up).
 */
export async function resetLoginAttempts(db: DbLike, email: string, ip: string | null | undefined, scope: LoginAttemptScope = {}): Promise<void> {
  await limiters.login.reset(db, emailIpKey(email, ip));
  if (scope.deviceId) await limiters.loginDevice.reset(db, emailDeviceKey(email, scope.deviceId));
}

/**
 * The person just proved they own the address (a reset link reached it, UX-01): forget the wrong passwords typed for
 * it — the per-email backstop AND this network's key — so the new password works straight away.
 */
export async function clearLoginLockout(db: DbLike, email: string, ip: string | null | undefined): Promise<void> {
  await limiters.loginEmail.reset(db, emailKey(email));
  await limiters.login.reset(db, emailIpKey(email, ip));
}

/* ------------------------------------------------------------------ */
/*  Front door (every attempt counts)                                  */
/* ------------------------------------------------------------------ */

/** Is another sign-up from this IP (or, without one, for this email) allowed? Does not record. */
export async function checkSignupAttempt(db: DbLike, ip: string | null | undefined, email: string, nowMs?: number): Promise<RateLimitResult> {
  return limiters.signup.check(db, signupKey(ip, email), nowMs);
}

/** Records a sign-up attempt and returns the state after it. */
export async function recordSignupAttempt(db: DbLike, ip: string | null | undefined, email: string, nowMs?: number): Promise<RateLimitResult> {
  return limiters.signup.hit(db, signupKey(ip, email), nowMs);
}

export async function checkPasswordResetRequest(db: DbLike, email: string, ip: string | null | undefined, nowMs?: number): Promise<RateLimitResult> {
  return limiters.passwordReset.check(db, emailIpKey(email, ip), nowMs);
}

/** Records a forgot-password request and returns the state after it. */
export async function recordPasswordResetRequest(db: DbLike, email: string, ip: string | null | undefined, nowMs?: number): Promise<RateLimitResult> {
  return limiters.passwordReset.hit(db, emailIpKey(email, ip), nowMs);
}
