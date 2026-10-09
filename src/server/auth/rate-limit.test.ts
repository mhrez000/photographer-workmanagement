import { beforeEach, describe, expect, it } from "vitest";
import { LOGIN_RATE_LIMIT } from "@/lib/constants";
import {
  LOGIN_EMAIL_RATE_LIMIT,
  checkLoginAttempt,
  clearLoginRateLimits,
  recordLoginAttemptFailure,
  resetLoginAttempts,
} from "./rate-limit";

const T0 = Date.parse("2026-10-09T00:00:00.000Z");
const EMAIL = "victim@studio.test";

beforeEach(() => clearLoginRateLimits());

describe("login rate limits (email+IP and email-only)", () => {
  it("blocks one email+IP after LOGIN_RATE_LIMIT failures; another IP still has attempts", () => {
    for (let i = 0; i < LOGIN_RATE_LIMIT.attempts - 1; i += 1) expect(recordLoginAttemptFailure(EMAIL, "1.1.1.1", T0 + i).allowed).toBe(true);
    expect(recordLoginAttemptFailure(EMAIL, "1.1.1.1", T0 + 10).allowed).toBe(false);
    expect(checkLoginAttempt(EMAIL, "1.1.1.1", T0 + 11).allowed).toBe(false);
    expect(checkLoginAttempt(EMAIL, "2.2.2.2", T0 + 11).allowed).toBe(true);
  });

  it("blocks the email after LOGIN_EMAIL_RATE_LIMIT failures however many IPs they came from", () => {
    for (let i = 0; i < LOGIN_EMAIL_RATE_LIMIT.attempts - 1; i += 1) {
      expect(recordLoginAttemptFailure(EMAIL, `10.0.${i}.1`, T0 + i).allowed).toBe(true);
    }
    const last = recordLoginAttemptFailure(EMAIL, "10.9.9.9", T0 + 100);
    expect(last.allowed).toBe(false);
    expect(last.retryAfterSeconds).toBeGreaterThan(0);
    expect(checkLoginAttempt(EMAIL, "192.0.2.1", T0 + 200).allowed).toBe(false);
    expect(checkLoginAttempt(" Victim@Studio.test ", null, T0 + 200).allowed).toBe(false);
    expect(checkLoginAttempt("someone-else@studio.test", "192.0.2.1", T0 + 200).allowed).toBe(true);
    // the window drains with time
    expect(checkLoginAttempt(EMAIL, "192.0.2.1", T0 + LOGIN_EMAIL_RATE_LIMIT.windowMinutes * 60_000 + 101).allowed).toBe(true);
  });

  it("a successful login clears only the email+IP key, not the per-email window", () => {
    for (let i = 0; i < LOGIN_EMAIL_RATE_LIMIT.attempts - 1; i += 1) recordLoginAttemptFailure(EMAIL, `10.0.${i}.1`, T0 + i);
    resetLoginAttempts(EMAIL, "10.0.0.1");
    expect(recordLoginAttemptFailure(EMAIL, "10.0.0.1", T0 + 50).allowed).toBe(false);
  });
});
