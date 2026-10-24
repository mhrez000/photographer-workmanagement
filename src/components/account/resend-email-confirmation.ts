/**
 * "Send again" for "Confirm your email" (AREA verify): the call, its outcomes in plain words, and the toast the banner
 * and My account show. Client-side only (imported by client components).
 */
import * as React from "react";
import { minutesLeft, retryAfterOf } from "@/components/auth/auth-helpers";
import { toast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api-client";
import type { EmailConfirmationSendResult } from "@/server/services/emailVerification";

/** POST /api/auth/email-verification/resend — the one "Send again" call (banner, My account, the link page). */
export const RESEND_CONFIRMATION_PATH = "/api/auth/email-verification/resend";

const TRY_AGAIN = "Something went wrong. Please try again.";

/** What happened when the person asked for a new "Confirm your email" link, in plain words for the screen. */
export type ResendConfirmationOutcome =
  /** Emailed. */
  | { kind: "sent" }
  /** Development only (no mail provider): the link to open instead. */
  | { kind: "dev_link"; url: string }
  /** Nothing to do: the address is confirmed (refresh the page so the banner goes away). */
  | { kind: "already_confirmed" }
  /** 5 an hour: "Try again in N minutes". */
  | { kind: "rate_limited"; wait: string }
  /** Nothing was sent, and trying again later may help. */
  | { kind: "failed"; message: string };

/** Maps the API result to an outcome. Exported for tests. */
export function outcomeOfResult(result: EmailConfirmationSendResult): ResendConfirmationOutcome {
  if (result.sent) return { kind: "sent" };
  if (result.devLink) return { kind: "dev_link", url: result.devLink };
  if (result.reason === "already_confirmed") return { kind: "already_confirmed" };
  if (result.reason === "failed") return { kind: "failed", message: "The email didn’t go out just now. Please try again in a few minutes." };
  // "demo" / "not_configured": the banner and the "Send again" buttons are hidden then; say it plainly anyway.
  return { kind: "failed", message: "Email isn’t set up for this studio yet." };
}

/** Maps a failed call to an outcome. Exported for tests. */
export function outcomeOfError(err: unknown): ResendConfirmationOutcome {
  if (!(err instanceof ApiError)) return { kind: "failed", message: TRY_AGAIN };
  if (err.status === 429) return { kind: "rate_limited", wait: minutesLeft(retryAfterOf(err)) };
  if (err.status === 422) return { kind: "already_confirmed" };
  if (err.status === 401) return { kind: "failed", message: "You’ve been logged out. Sign in again, then ask for a new link." };
  if (err.code === "network") return { kind: "failed", message: "We couldn’t reach Proofline. Check your connection and try again." };
  return { kind: "failed", message: err.message || TRY_AGAIN };
}

/** One "Send again" press. Never throws. */
export async function requestNewConfirmationLink(): Promise<ResendConfirmationOutcome> {
  try {
    return outcomeOfResult(await api.post<EmailConfirmationSendResult>(RESEND_CONFIRMATION_PATH, {}));
  } catch (err) {
    return outcomeOfError(err);
  }
}

/**
 * The toast the banner and My account show for an outcome (the link page shows its own inline messages).
 * `onConfirmed` runs for "already confirmed" (refresh the page so the banner / "Not confirmed yet" goes away).
 */
export function toastResendOutcome(outcome: ResendConfirmationOutcome, email: string, onConfirmed?: () => void): void {
  switch (outcome.kind) {
    case "sent":
      toast.success(`We sent a new link to ${email}`, "Open it within 24 hours to confirm your email. Check your spam folder if it isn’t there.");
      return;
    case "dev_link":
      toast({
        title: "Email isn’t set up on this computer",
        description: "Development only: open the confirmation link directly.",
        variant: "info",
        duration: 0,
        action: { label: "Open link", onClick: () => window.location.assign(outcome.url) },
      });
      return;
    case "already_confirmed":
      toast.success("Your email is already confirmed");
      onConfirmed?.();
      return;
    case "rate_limited":
      toast.warning("You’ve asked for a lot of links", `Try again in ${outcome.wait}. The last link we sent still works.`);
      return;
    case "failed":
      toast.error("No new link was sent", outcome.message);
      return;
  }
}

/** The "Send again" button state: `send()` resolves with the outcome; `pending` while the request runs. */
export function useResendEmailConfirmation(): { pending: boolean; send: () => Promise<ResendConfirmationOutcome | null> } {
  const [pending, setPending] = React.useState(false);
  const busy = React.useRef(false);
  const send = React.useCallback(async () => {
    if (busy.current) return null;
    busy.current = true;
    setPending(true);
    try {
      return await requestNewConfirmationLink();
    } finally {
      busy.current = false;
      setPending(false);
    }
  }, []);
  return { pending, send };
}
