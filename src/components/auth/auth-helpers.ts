import type { ApiError } from "@/lib/api-client";

/** First message per field from a 400, for FormField `error` props. */
export function firstErrors(err: ApiError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, messages] of Object.entries(err.fieldErrors)) if (messages?.[0]) out[key] = messages[0];
  return out;
}

/** Seconds → "a minute" / "N minutes" (never less than a minute, so the wait never reads as zero). */
export function minutesLeft(seconds: number | null | undefined): string {
  const m = Math.max(1, Math.ceil((seconds ?? 60) / 60));
  return m <= 1 ? "a minute" : `${m} minutes`;
}

/** `retryAfterSeconds` of a 429 (the server puts it in `details`, mirroring the retry-after header). */
export function retryAfterOf(err: ApiError): number | null {
  const d = err.details as { retryAfterSeconds?: unknown } | undefined;
  return typeof d?.retryAfterSeconds === "number" ? d.retryAfterSeconds : null;
}

/** The browser's IANA timezone (e.g. "Australia/Sydney"), or null when it cannot tell. */
export function browserTimezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz !== "Etc/Unknown" ? tz : null;
  } catch {
    return null;
  }
}

/** "Australia/Sydney" → "Sydney (Australia)" for a quiet one-liner. */
export function describeTimezone(tz: string): string {
  const parts = tz.split("/");
  if (parts.length < 2) return tz;
  const city = parts[parts.length - 1].replace(/_/g, " ");
  return `${city} (${parts[0].replace(/_/g, " ")})`;
}

/** The one plain-words body of a dead link (invite or reset). Neutral on purpose: a pasted-wrong link is far
 * more common than a used or expired one, and the reader is the invitee, not the owner, so no menu paths. */
export const DEAD_LINK_CHECK = "Check you copied the whole link";

/** Body of a dead invite link (server-rendered and client-side states share it). */
export function invalidInviteBody(studioName?: string | null): string {
  const who = studioName ? studioName : "whoever invited you";
  return `This link didn’t open. ${DEAD_LINK_CHECK}, or ask ${who} to send it again. Invite links work once and last 7 days.`;
}

/** Body of a dead password-reset link. */
export const INVALID_RESET_BODY = `This link didn’t open. ${DEAD_LINK_CHECK}, or ask for a new one and we’ll email it straight away. Reset links work once and last 60 minutes.`;

/** Under the generic sign-in / reset messages: the kind hint for someone whose invite was never opened. Constant, so it reveals nothing about any address. */
export const INVITED_HINT = "If you were invited, use the link you were sent (ask for a new one if it has expired).";
