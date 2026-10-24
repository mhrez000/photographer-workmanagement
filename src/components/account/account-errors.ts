import { minutesLeft, retryAfterOf } from "@/components/auth/auth-helpers";
import { ApiError } from "@/lib/api-client";

/** First message per field of a 400 / 422, for FormField `error` props. */
export function fieldErrorsOf(err: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!(err instanceof ApiError) || err.code !== "validation") return out;
  for (const [key, messages] of Object.entries(err.fieldErrors)) if (messages?.[0]) out[key] = messages[0];
  return out;
}

/**
 * One plain sentence for a failed account request (My account cards). The server's own copy is already plain
 * (the demo studio's 403, "You already have a password…"); a 429 says how long to wait.
 */
export function accountErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "rate_limited") {
      // The account services say what was limited ("Too many wrong passwords. Try again in 12 minutes."); the
      // generic 429 copy has no wait in it, so build one from `retryAfterSeconds`.
      return /try again in/i.test(err.message) ? err.message : `Too many tries. Try again in ${minutesLeft(retryAfterOf(err))}.`;
    }
    if (err.code === "internal") return "Something went wrong on our side. Please try again.";
    return err.message;
  }
  return "Something went wrong. Please try again.";
}
