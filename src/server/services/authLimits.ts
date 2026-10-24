/**
 * The front door's rate limits in plain words (docs/ACCOUNTS.md §6). The counting itself is the foundation's
 * Postgres-backed `src/server/auth/db-rate-limit.ts`; this file only adds what the services of AREA access need on
 * top of it:
 *
 *   - `plainRateLimited(topic, seconds)`  a 429 (`RateLimitedError`: `retry-after` header + `details.retryAfterSeconds`)
 *                                         whose message says what was limited and how many minutes to wait
 *   - `enforceLimit(db, name, key, topic)` `enforceRateLimit` (every attempt counts) with that plain copy
 *   - `limiterNow()`                      the services' injectable clock (src/server/clock.ts) in ms, so tests can move
 *                                         time and a window really drains
 *   - `resetLinkLimiter` / `resetLinkKey`  dead reset links per client IP (the reset form hashes the new password
 *                                         before it can tell a dead link, so this caps the bcrypt work a stranger can
 *                                         cause; only counted when the client IP is known — an "unknown" bucket shared
 *                                         by everyone would let one person block every reset)
 */
import type { DbLike } from "@/db/index";
import { RATE_LIMITS, type RateLimiterName } from "@/lib/constants";
import { enforceRateLimit, ipKey, limiters, type RateLimitResult } from "@/server/auth/db-rate-limit";
import { nowIso } from "@/server/clock";
import { RateLimitedError } from "@/server/errors";

/** What a 429 was about (picks the first sentence of the message). */
export type LimitTopic = "sign_in" | "signup" | "forgot_password" | "reset_link" | "password_check" | "demo";

const LEADS: Readonly<Record<LimitTopic, string>> = {
  sign_in: "Too many sign-in attempts.",
  signup: "Too many new studios from this network.",
  forgot_password: "Too many reset emails asked for.",
  reset_link: "Too many tries with reset links that no longer work.",
  password_check: "Too many wrong passwords.",
  demo: "Too many demo sign-ins from this network.",
};

/** Seconds → "a minute" / "N minutes" (never less than a minute, so the wait never reads as zero). */
export function waitInWords(seconds: number): string {
  const minutes = Math.max(1, Math.ceil((Number.isFinite(seconds) ? seconds : 60) / 60));
  return minutes === 1 ? "a minute" : `${minutes} minutes`;
}

/** "Too many sign-in attempts. Try again in 12 minutes." */
export function rateLimitMessage(topic: LimitTopic, retryAfterSeconds: number): string {
  return `${LEADS[topic]} Try again in ${waitInWords(retryAfterSeconds)}.`;
}

/** A 429 with plain copy; `retryAfterSeconds` still drives the `retry-after` header (src/server/http.ts). */
export function plainRateLimited(topic: LimitTopic, retryAfterSeconds: number): RateLimitedError {
  const err = new RateLimitedError(retryAfterSeconds);
  err.message = rateLimitMessage(topic, retryAfterSeconds);
  return err;
}

/** The services' clock in ms (the real clock in production; tests move it with `fakeClock`). */
export function limiterNow(): number {
  return Date.parse(nowIso());
}

/** `enforceRateLimit` (check → 429, else record this attempt) with a plain-words 429. */
export async function enforceLimit(db: DbLike, name: RateLimiterName, key: string, topic: LimitTopic, nowMs: number = limiterNow()): Promise<RateLimitResult> {
  try {
    return await enforceRateLimit(db, name, key, nowMs);
  } catch (err) {
    if (err instanceof RateLimitedError) throw plainRateLimited(topic, err.retryAfterSeconds);
    throw err;
  }
}

/** Dead reset links per client IP: 10 per 15 minutes (`RATE_LIMITS.resetLink`). */
export const RESET_LINK_LIMIT = RATE_LIMITS.resetLink;
export const resetLinkLimiter = limiters.resetLink;

/** `reset-link|ip|<address>`, or null when the client IP is unknown (then nothing is counted). */
export function resetLinkKey(ip: string | null | undefined): string | null {
  const address = ip?.trim();
  return address ? `reset-link|${ipKey(address)}` : null;
}
