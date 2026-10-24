/**
 * Session tokens and signed short-lived cookies — the pure half of src/server/auth/session.ts (no DB, no
 * `next/headers`), so the edge gate (`src/proxy.ts`, Node.js runtime) can verify and renew the session cookie.
 *
 * - `SESSION_SECRET` (≥ 32 chars) is REQUIRED in production; the module throws at load time without it. Local
 *   dev falls back to data/.session-secret (generated once, gitignored).
 * - Session token: jose HS256 `{ sub, sv, k?, r?, at? }` + `iat` / `exp` (SESSION_TTL_DAYS); `at` = when this browser
 *   last really signed in (kept by renewals). Sliding sessions
 *   (docs/ACCOUNTS.md): `renewSessionToken` hands back a fresh token once the current one is older than
 *   SESSION_RENEW_AFTER_HOURS; `session_version` is still checked on every request by session.ts.
 * - Purpose tokens (`signPurposeToken` / `verifyPurposeToken`): the same key, a mandatory `pur` claim and a short
 *   expiry — for state that must survive a redirect (Google sign-in). A purpose token is never accepted as a
 *   session and a session token never as a purpose token.
 */
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { SESSION_RENEW_AFTER_HOURS, SESSION_TTL_DAYS } from "@/lib/constants";
import type { SessionPayload } from "@/lib/types";

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

/**
 * A keyed hash (HMAC-SHA256 with the session secret, hex) of `value` for one `purpose` — for values stored or sent
 * where a plain sha256 could be confirmed by anyone who can guess the input (an email address, an IP): the
 * `auth_rate_limits.key_hash` column (DATA-07) and the known-device cookie's address tag.
 */
export function keyedHash(purpose: string, value: string): string {
  return createHmac("sha256", secretKey).update(`${purpose}\u0000${value}`, "utf8").digest("hex");
}

export const SESSION_TTL_SECONDS = SESSION_TTL_DAYS * 24 * 60 * 60;
export const SESSION_RENEW_AFTER_SECONDS = SESSION_RENEW_AFTER_HOURS * 60 * 60;

/* ------------------------------------------------------------------ */
/*  Session tokens                                                     */
/* ------------------------------------------------------------------ */

export async function signSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({
    sv: payload.sv,
    ...(payload.k ? { k: payload.k } : {}),
    ...(payload.r ? { r: payload.r } : {}),
    ...(typeof payload.at === "number" ? { at: payload.at } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey);
}

function sessionPayloadOf(payload: JWTPayload): SessionPayload | null {
  // A purpose token (Google round trip, …) is signed with the same key: never a session.
  if (payload.pur !== undefined) return null;
  const sv = payload.sv;
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
  if (typeof sv !== "number" || !Number.isInteger(sv)) return null;
  const k = payload.k === "client" ? "client" : "staff";
  const r = payload.r === "editor" || payload.r === "client" || payload.r === "photographer" ? payload.r : undefined;
  const at = typeof payload.at === "number" && Number.isInteger(payload.at) && payload.at > 0 ? payload.at : undefined;
  return { sub: payload.sub, sv, k, ...(r ? { r } : {}), ...(at ? { at } : {}) };
}

/** Verifies signature + expiry; returns null for anything invalid. */
export async function verifySessionToken(token: string | null | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey, { algorithms: ["HS256"] });
    return sessionPayloadOf(payload);
  } catch {
    return null;
  }
}

/** Verified session claims plus when the token was issued (seconds since the epoch); null when invalid. */
export async function readSessionClaims(token: string | null | undefined): Promise<(SessionPayload & { iat: number }) | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey, { algorithms: ["HS256"] });
    const session = sessionPayloadOf(payload);
    if (!session || typeof payload.iat !== "number") return null;
    return { ...session, iat: payload.iat };
  } catch {
    return null;
  }
}

/**
 * Sliding sessions: a fresh token (same `sub` / `sv` / `k` / `r`, new `iat` / `exp`) when `token` is valid and was
 * issued more than SESSION_RENEW_AFTER_HOURS ago; null when it is invalid or still fresh. The caller sets it with
 * `sessionCookieOptions()`. A revoked session (stale `sv`) still renews here — session.ts rejects it on the same
 * request, and the app then sends the person to /login?expired=1, which deletes the cookie.
 */
export async function renewSessionToken(token: string | null | undefined, nowMs: number = Date.now()): Promise<string | null> {
  const claims = await readSessionClaims(token);
  if (!claims) return null;
  if (Math.floor(nowMs / 1000) - claims.iat < SESSION_RENEW_AFTER_SECONDS) return null;
  // The sign-in time travels with the session: a renewal is not a new sign-in.
  return signSessionToken({
    sub: claims.sub,
    sv: claims.sv,
    ...(claims.k ? { k: claims.k } : {}),
    ...(claims.r ? { r: claims.r } : {}),
    ...(claims.at ? { at: claims.at } : {}),
  });
}

/** Options for the session cookie (`pwm_session`): httpOnly, lax, secure in production, 30 days by default. */
export function sessionCookieOptions(maxAgeSeconds: number = SESSION_TTL_SECONDS) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/* ------------------------------------------------------------------ */
/*  Purpose tokens (short-lived signed cookies)                        */
/* ------------------------------------------------------------------ */

/**
 * Signs `claims` for one purpose (e.g. "google_oauth") with a short expiry. Put no secrets the browser must not
 * read into it: the cookie is signed, not encrypted (httpOnly keeps scripts away; the user can still decode it).
 */
export async function signPurposeToken(claims: Record<string, unknown>, purpose: string, ttlSeconds: number): Promise<string> {
  return new SignJWT({ ...claims, pur: purpose })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(`${Math.max(1, Math.floor(ttlSeconds))}s`)
    .sign(secretKey);
}

/** The claims of a valid, unexpired token signed for `purpose` (without `pur` / `iat` / `exp`); null otherwise. */
export async function verifyPurposeToken<T extends Record<string, unknown>>(token: string | null | undefined, purpose: string): Promise<T | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey, { algorithms: ["HS256"] });
    if (payload.pur !== purpose) return null;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { pur, iat, exp, ...claims } = payload;
    return claims as T;
  } catch {
    return null;
  }
}
