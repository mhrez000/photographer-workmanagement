/**
 * "Continue with Google" — the plain words and links shared by the sign-in / sign-up / invite pages, the
 * /signup/google finish page and the Google card on My account. Pure (no server or browser APIs): safe in server
 * components and client islands alike.
 */
import { GOOGLE_RESULTS, type GoogleIntent, type GoogleResult } from "@/lib/constants";
import { safeNextPath } from "@/server/auth/redirect";
import type { FormAlertTone } from "./form-alert";

/** Where a `?google=<result>` is shown. */
export type GoogleSurface = "signin" | "signup" | "invite" | "account";

export interface GoogleResultMessage {
  tone: FormAlertTone;
  text: string;
}

export function isGoogleResult(value: unknown): value is GoogleResult {
  return typeof value === "string" && (GOOGLE_RESULTS as readonly string[]).includes(value);
}

/**
 * The plain-words message for a round trip's result on one surface, or null (unknown / not shown there).
 * `refused` never says why (no account oracle): it reads the same for a deactivated account, a closed client portal,
 * a demo account or an address Google cannot vouch for.
 */
export function googleResultMessage(result: string | null | undefined, surface: GoogleSurface): GoogleResultMessage | null {
  if (!isGoogleResult(result)) return null;
  const account = surface === "account";
  switch (result) {
    case "cancelled":
      return { tone: "neutral", text: account ? "Google wasn’t connected: you cancelled on Google’s page." : "You cancelled on Google’s page, so nothing changed." };
    case "expired":
      return { tone: "attention", text: "That took a little too long, so we stopped for your safety. Please try Continue with Google again." };
    case "failed":
      return {
        tone: "danger",
        text: account ? "We couldn’t connect Google just now. Wait a moment, then try again." : "We couldn’t finish with Google just now. Wait a moment, then try again.",
      };
    case "refused":
      if (account) return { tone: "danger", text: "That Google account can’t be connected to this account." };
      if (surface === "invite") return { tone: "danger", text: "We couldn’t use that Google account for this invite. Choose a password instead, or ask the studio to send a new invite." };
      return { tone: "danger", text: "We couldn’t sign you in with that Google account. Try your email and password, or ask your studio for help." };
    case "use_password":
      // SEC-01: Google never takes over an account that has a password. Only the verified owner of the address sees it.
      if (account) return null;
      return {
        tone: "attention",
        text: "There’s already a Proofline account with that email. Sign in with your password below (or reset it if you’ve forgotten it), then turn on Google in My account.",
      };
    case "unverified_email":
      return { tone: "attention", text: "Google hasn’t confirmed the email address of that Google account yet, so we can’t use it. Confirm it with Google first, or use your email and a password." };
    case "linked_elsewhere":
      return { tone: "attention", text: "That Google account is already connected to a different Proofline account. Choose another Google account." };
    case "no_account":
      return { tone: "neutral", text: "There’s no Proofline account for that Google account yet." };
    case "disabled":
      if (account) return { tone: "neutral", text: "Continue with Google isn’t available right now." };
      return { tone: "neutral", text: surface === "signup" ? "Continue with Google isn’t available right now. Fill in the form instead." : "Continue with Google isn’t available right now. Use your email and password instead." };
    case "connected":
      return account ? { tone: "success", text: "Google is connected. Next time you can sign in with Google." } : null;
    case "disconnected":
      return account ? { tone: "success", text: "Google is disconnected. Sign in with your email and password from now on." } : null;
    default:
      return null;
  }
}

export interface GoogleStartLinkInput {
  intent: GoogleIntent;
  /** Sign-in only: where to land afterwards (sanitised here AND on the server). */
  next?: string | null;
  /** Invite only: the cleaned invite token. */
  invite?: string | null;
}

/** GET /api/auth/google/start?intent=…(&next=…)(&invite=…) — a full-page navigation, never a fetch. */
export function googleStartHref({ intent, next, invite }: GoogleStartLinkInput): string {
  const params = new URLSearchParams({ intent });
  const safeNext = intent === "signin" ? safeNextPath(next) : null;
  if (safeNext) params.set("next", safeNext);
  if (intent === "invite" && invite) params.set("invite", invite);
  return `/api/auth/google/start?${params.toString()}`;
}
