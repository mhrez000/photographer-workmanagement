/**
 * In-memory sliding-window limiters for login attempts. Process-local by
 * design (single-node SQLite app); state survives dev HMR via globalThis.
 * A login must pass BOTH:
 *
 *   - per email+IP (LOGIN_RATE_LIMIT: 5 failures / 15 min) — the tight one
 *   - per email only (LOGIN_EMAIL_RATE_LIMIT: 20 failures / 15 min) — the
 *     IP-independent backstop, so rotating (or spoofing) the client address
 *     never buys unlimited guesses against one account
 *
 * Only failures are recorded. A successful login clears the email+IP key;
 * the per-email window is NOT cleared (it only drains with time), so a
 * victim's own successful sign-in cannot top an attacker back up.
 */
import { LOGIN_RATE_LIMIT } from "@/lib/constants";

export interface RateLimitResult {
  allowed: boolean;
  /** Failures still allowed inside the window. */
  remaining: number;
  /** Seconds until the oldest failure leaves the window (0 when allowed). */
  retryAfterSeconds: number;
}

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly attempts: number,
    readonly windowMs: number,
  ) {}

  private prune(key: string, nowMs: number): number[] {
    const cutoff = nowMs - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }

  check(key: string, nowMs: number = Date.now()): RateLimitResult {
    const list = this.prune(key, nowMs);
    if (list.length < this.attempts) {
      return { allowed: true, remaining: this.attempts - list.length, retryAfterSeconds: 0 };
    }
    const oldestRelevant = list[list.length - this.attempts];
    const retryAfterMs = oldestRelevant + this.windowMs - nowMs;
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }

  hit(key: string, nowMs: number = Date.now()): RateLimitResult {
    const list = this.prune(key, nowMs);
    list.push(nowMs);
    this.hits.set(key, list);
    return this.check(key, nowMs);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  clear(): void {
    this.hits.clear();
  }
}

/** IP-independent backstop: failures per email, whatever address they come from. */
export const LOGIN_EMAIL_RATE_LIMIT = { attempts: 20, windowMinutes: 15 } as const;

const globalForLimiter = globalThis as unknown as {
  __pwmLoginLimiter?: SlidingWindowLimiter;
  __pwmLoginEmailLimiter?: SlidingWindowLimiter;
};

export const loginLimiter: SlidingWindowLimiter = (globalForLimiter.__pwmLoginLimiter ??= new SlidingWindowLimiter(
  LOGIN_RATE_LIMIT.attempts,
  LOGIN_RATE_LIMIT.windowMinutes * 60_000,
));

export const loginEmailLimiter: SlidingWindowLimiter = (globalForLimiter.__pwmLoginEmailLimiter ??= new SlidingWindowLimiter(
  LOGIN_EMAIL_RATE_LIMIT.attempts,
  LOGIN_EMAIL_RATE_LIMIT.windowMinutes * 60_000,
));

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function loginRateLimitKey(email: string, ip: string | null | undefined): string {
  return `${normaliseEmail(email)}|${ip?.trim() || "unknown"}`;
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

/** Is another login attempt for this email (from this IP) allowed under both limiters? (Does not record.) */
export function checkLoginAttempt(email: string, ip: string | null | undefined, nowMs?: number): RateLimitResult {
  return strictest(loginLimiter.check(loginRateLimitKey(email, ip), nowMs), loginEmailLimiter.check(normaliseEmail(email), nowMs));
}

/** Record a failed attempt in both limiters; returns the combined state after recording. */
export function recordLoginAttemptFailure(email: string, ip: string | null | undefined, nowMs?: number): RateLimitResult {
  return strictest(loginLimiter.hit(loginRateLimitKey(email, ip), nowMs), loginEmailLimiter.hit(normaliseEmail(email), nowMs));
}

/** After a successful login: clear the email+IP key (the per-email window drains with time only). */
export function resetLoginAttempts(email: string, ip: string | null | undefined): void {
  loginLimiter.reset(loginRateLimitKey(email, ip));
}

/** Tests only. */
export function clearLoginRateLimits(): void {
  loginLimiter.clear();
  loginEmailLimiter.clear();
}
