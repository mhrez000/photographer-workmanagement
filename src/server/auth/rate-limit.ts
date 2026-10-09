/**
 * In-memory sliding-window limiter for login attempts (LOGIN_RATE_LIMIT:
 * 5 failed attempts per 15 minutes per email+IP). Process-local by design
 * (single-node SQLite app); state survives dev HMR via globalThis.
 *
 * Only failures are recorded; a successful login clears the key.
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

const globalForLimiter = globalThis as unknown as { __pwmLoginLimiter?: SlidingWindowLimiter };

export const loginLimiter: SlidingWindowLimiter = (globalForLimiter.__pwmLoginLimiter ??= new SlidingWindowLimiter(
  LOGIN_RATE_LIMIT.attempts,
  LOGIN_RATE_LIMIT.windowMinutes * 60_000,
));

export function loginRateLimitKey(email: string, ip: string | null | undefined): string {
  return `${email.trim().toLowerCase()}|${ip?.trim() || "unknown"}`;
}

/** Is another login attempt allowed for this key? (Does not record.) */
export function checkLoginRateLimit(key: string, nowMs?: number): RateLimitResult {
  return loginLimiter.check(key, nowMs);
}

/** Record a failed attempt; returns the state after recording. */
export function recordLoginFailure(key: string, nowMs?: number): RateLimitResult {
  return loginLimiter.hit(key, nowMs);
}

/** Clear the key after a successful login. */
export function resetLoginRateLimit(key: string): void {
  loginLimiter.reset(key);
}

/** Tests only. */
export function clearLoginRateLimits(): void {
  loginLimiter.clear();
}
