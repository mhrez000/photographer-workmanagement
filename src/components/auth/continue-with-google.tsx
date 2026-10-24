import { Separator } from "@/components/ui/separator";
import type { GoogleIntent } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { googleAuthConfig } from "@/server/auth/google-config";
import { FormAlert } from "./form-alert";
import { GoogleButton } from "./google-button";
import { googleResultMessage, googleStartHref } from "./google-sign-in";

export interface ContinueWithGoogleProps {
  /** What the person is doing on this page: /login → "signin", /signup → "signup", /invite/[token] → "invite". */
  intent: Exclude<GoogleIntent, "connect">;
  /** /login's `?next=` (sanitised server-side with `safeNextPath` before use). */
  next?: string;
  /** /invite/[token]: the (cleaned) invite token. */
  invite?: string;
  className?: string;
}

/**
 * "Continue with Google" on /login, /signup and /invite/[token] (docs/ACCOUNTS.md §1). A server component: renders
 * NOTHING unless Google sign-in is configured (`googleAuthConfig()`: GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET).
 * Configured: an "or" divider under the page's own form, then the full-width Google button →
 * GET /api/auth/google/start?intent=…(&next=…)(&invite=…). The result of a round trip is NOT shown here but at the top
 * of the page (`GoogleResultAlert`, UX-16), where someone coming back from Google looks first. Never import it from a
 * client module (it reads the server's environment); pass it to a client island as a rendered element instead.
 */
export function ContinueWithGoogle({ intent, next, invite, className }: ContinueWithGoogleProps) {
  if (googleAuthConfig() === null) return null;
  if (intent === "invite" && !invite) return null;
  return (
    <div className={cn("flex flex-col gap-4", className)} data-continue-with-google={intent}>
      <Separator label="or" decorative />
      <GoogleButton href={googleStartHref({ intent, next, invite })} />
      {intent === "invite" ? <p className="text-center text-xs text-ink-subtle">No password to remember: you’ll sign in with Google from then on.</p> : null}
    </div>
  );
}

export interface GoogleResultAlertProps {
  /** The page it is shown on (the words differ a little: sign-in, sign-up, invite). */
  surface: Exclude<GoogleIntent, "connect">;
  /** The page's `?google=<GoogleResult>` after a round trip (cancelled, refused, use_password, disabled, …). */
  result?: string;
  className?: string;
}

/**
 * The plain-words result of a Google round trip, at the TOP of the page like the other form alerts (UX-16). Shown
 * whether or not Google is configured now (a round trip that found it off says "isn't available right now").
 */
export function GoogleResultAlert({ surface, result, className }: GoogleResultAlertProps) {
  const message = googleResultMessage(result, surface);
  if (!message) return null;
  return (
    <FormAlert tone={message.tone} className={className}>
      <span data-google-result={result}>{message.text}</span>
    </FormAlert>
  );
}
