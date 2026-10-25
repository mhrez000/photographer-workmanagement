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

/** The one heading of a dead link page (UX-14: the same words on every dead-link page). */
export const DEAD_LINK_HEADING = "This link isn’t working";
/** …and of a dead invite link. */
export const DEAD_INVITE_HEADING = "This invite link isn’t working";

/**
 * Body of a dead invite link (server-rendered and client-side states share it). Signed out, joining before is the
 * likeliest reason, so it comes first (UX-06); `signedIn` drops that part (they are signed in already).
 */
export function invalidInviteBody(studioName?: string | null, opts: { signedIn?: boolean } = {}): string {
  const who = studioName ? studioName : "whoever invited you";
  const rest = `${DEAD_LINK_CHECK}, or ask ${who} for a new one — invite links work once and last 7 days.`;
  return opts.signedIn ? rest : `Already joined? Sign in below. Otherwise ${rest.charAt(0).toLowerCase()}${rest.slice(1)}`;
}

/** Body of a dead password-reset link. */
export const INVALID_RESET_BODY = `${DEAD_LINK_CHECK}, or ask for a new one and we’ll email it straight away. Reset links work once and last 60 minutes.`;

/** Under the generic sign-in / reset messages: the kind hint for someone whose invite was never opened. Constant, so it reveals nothing about any address. */
export const INVITED_HINT = "If you were invited, use the link you were sent (ask for a new one if it has expired).";

/**
 * The words on a "back to where I work" button for a signed-in person (UX-11): owners / photographers have a studio,
 * editors have their jobs, clients have their work. Pure: server and client components alike.
 */
export function homeLabelFor(role: "photographer" | "editor" | "client"): string {
  if (role === "editor") return "Go to my jobs";
  if (role === "client") return "See your work";
  return "Go to your studio";
}

/** What logging out does, in one sentence (UX-03: "Log out" ends the account's sign-in on every device). */
export const LOG_OUT_EVERYWHERE_NOTE = "Logging out also logs you out on your other devices.";
