"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Camera, Clock, Mail, Sparkles, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api-client";
import { SIGNUP_HONEYPOT_FIELD, STUDIO_NAME_MAX_LENGTH } from "@/lib/constants";
import { browserTimezone, describeTimezone, firstErrors, minutesLeft, retryAfterOf } from "./auth-helpers";
import { FormAlert } from "./form-alert";
import { googleStartHref } from "./google-sign-in";

/** `details.reason` of the 400 when the finish cookie is gone (src/server/services/googleAuth.ts). */
const EXPIRED_REASON = "google_signup_expired";
/** The server's "taken email" message ends with "Try signing in." — we add the link. */
const TAKEN_EMAIL = /already in use|already has a Proofline account/i;

interface GoogleSignUpResult {
  organisationId: string;
  slug: string;
  user: { id: string; name: string; email: string; role: string };
  redirectTo: string;
}

type ErrorKey = "ownerName" | "studioName" | "timezone";
type Errors = Partial<Record<ErrorKey, string>>;

const subscribeNever = () => () => {};
const noTimezone = () => null;

/**
 * The Google sign-up timed out (15 minutes) or this browser never had one: one friendly way back. Used by the
 * /signup/google page (server) and by the form when the API says the finish cookie is gone.
 */
export function GoogleSignUpStartAgain({ googleAvailable = true }: { googleAvailable?: boolean } = {}) {
  return (
    <div className="flex flex-col gap-5" data-google-start-again={googleAvailable ? "" : "unavailable"}>
      <Card className="shadow-md">
        <CardContent className="flex flex-col items-start gap-4 p-6 first:pt-6 last:pb-6">
          <div className="flex size-10 items-center justify-center rounded-full bg-attention-soft text-attention ring-1 ring-inset ring-attention/20">
            <Clock aria-hidden="true" className="size-5" />
          </div>
          {googleAvailable ? (
            <div role="status">
              <h2 className="text-md font-semibold text-ink">Let’s start that again</h2>
              <p className="mt-1 text-sm text-ink-muted">
                For your safety we only wait 15 minutes after you choose your Google account, so nothing was created. Press Continue with Google again: it only
                takes a moment.
              </p>
            </div>
          ) : (
            // UX-15: Google sign-in is off here, so "press Continue with Google again" would be impossible.
            <div role="status">
              <h2 className="text-md font-semibold text-ink">Signing up with Google isn’t available</h2>
              <p className="mt-1 text-sm text-ink-muted">Nothing was created. Create your studio with your email instead: it only takes a minute.</p>
            </div>
          )}
          <Button href="/signup" size="lg" className="w-full">
            {googleAvailable ? "Start again" : "Create your studio"}
          </Button>
        </CardContent>
      </Card>
      <p className="text-center text-sm text-ink-muted">
        Already have a studio?{" "}
        <Link href="/login" className="font-medium text-accent-ink underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}

export interface GoogleSignUpFormProps {
  /** The Google address (from the signed finish cookie; becomes the owner's confirmed email). */
  email: string;
  /** Google's display name, editable. */
  initialName: string;
  /** Came from "Continue with Google" on the SIGN-IN page: explain that there is no account yet. */
  fromSignIn: boolean;
  /** This browser is already signed in as someone (finishing switches to the new studio's owner). */
  signedInAs: string | null;
}

/**
 * /signup/google — finish "Create your studio" with Google (POST /api/auth/google/complete): only the studio name is
 * new; the name comes prefilled from Google (editable); the email is Google's and already confirmed. No password.
 * Field errors inline; a 429 says how long to wait; a timed-out sign-up swaps to the "start again" card.
 */
export function GoogleSignUpForm({ email, initialName, fromSignIn, signedInAs }: GoogleSignUpFormProps) {
  const router = useRouter();
  const [ownerName, setOwnerName] = React.useState(initialName);
  const [studioName, setStudioName] = React.useState("");
  const [website, setWebsite] = React.useState("");
  const detectedTimezone = React.useSyncExternalStore(subscribeNever, browserTimezone, noTimezone);
  const [timezoneRejected, setTimezoneRejected] = React.useState(false);
  const timezone = timezoneRejected ? null : detectedTimezone;
  const [errors, setErrors] = React.useState<Errors>({});
  const [formError, setFormError] = React.useState<{ tone: "danger" | "attention"; text: string; signIn?: boolean } | null>(null);
  const [expired, setExpired] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [done, setDone] = React.useState(false);

  if (expired) return <GoogleSignUpStartAgain />;

  const clearError = (key: ErrorKey) => {
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || done) return;
    const name = ownerName.trim();
    const studio = studioName.trim();
    const local: Errors = {};
    if (!name) local.ownerName = "Enter your name";
    if (!studio) local.studioName = "Enter your studio name";
    if (local.ownerName || local.studioName) {
      setErrors(local);
      return;
    }
    setPending(true);
    setErrors({});
    setFormError(null);
    try {
      const result = await api.post<GoogleSignUpResult>("/api/auth/google/complete", {
        studioName: studio,
        ownerName: name,
        ...(timezone ? { timezone } : {}),
        [SIGNUP_HONEYPOT_FIELD]: website,
      });
      setDone(true);
      router.push(result.redirectTo || "/home");
    } catch (err) {
      setPending(false);
      if (err instanceof ApiError && err.status === 429) {
        setFormError({ tone: "attention", text: `Too many sign-ups from this network. Try again in ${minutesLeft(retryAfterOf(err))}.` });
        return;
      }
      if (err instanceof ApiError && err.code === "validation") {
        if ((err.details as { reason?: unknown } | undefined)?.reason === EXPIRED_REASON) {
          setExpired(true);
          return;
        }
        const fe = firstErrors(err);
        if (fe.timezone) setTimezoneRejected(true);
        const fieldErrors: Errors = { ownerName: fe.ownerName, studioName: fe.studioName };
        if (fieldErrors.ownerName || fieldErrors.studioName) setErrors(fieldErrors);
        else if (!fe.timezone) setFormError({ tone: "danger", text: err.message, signIn: TAKEN_EMAIL.test(err.message) });
        else setFormError({ tone: "attention", text: "Please press Create your studio once more." });
        return;
      }
      setFormError({ tone: "danger", text: err instanceof ApiError ? err.message : "Something went wrong. Please try again." });
    }
  };

  const busy = pending || done;

  return (
    <div className="flex flex-col gap-5">
      {fromSignIn ? (
        <FormAlert tone="neutral">
          <span data-google-no-account="">
            There’s no Proofline account for <span className="break-words font-medium">{email}</span> yet. Create your studio below, or if you edit or shoot for a studio, ask
            them to send you an invite.
          </span>
        </FormAlert>
      ) : null}
      {signedInAs ? (
        <FormAlert tone="attention">
          This browser is signed in as <span className="font-medium">{signedInAs}</span>. Creating a studio signs you in as its owner instead.
        </FormAlert>
      ) : null}

      <Card className="shadow-md">
        <CardContent className="p-6 first:pt-6 last:pb-6">
          <form onSubmit={submit} className="relative flex flex-col gap-4" noValidate aria-busy={busy || undefined} aria-label="Create your studio with Google">
            {formError ? (
              <FormAlert tone={formError.tone}>
                {formError.text}
                {formError.signIn ? (
                  <>
                    {" "}
                    <Link href={`/login?email=${encodeURIComponent(email)}`} className="font-medium text-accent-ink underline-offset-4 hover:underline">
                      Sign in instead
                    </Link>
                  </>
                ) : null}
              </FormAlert>
            ) : null}

            <FormField label="Email" description="From your Google account, already confirmed.">
              <Input name="email" type="email" value={email} readOnly leading={<Mail aria-hidden="true" />} autoComplete="username" />
            </FormField>

            <FormField label="Your name" error={errors.ownerName} required>
              <Input
                name="ownerName"
                autoComplete="name"
                leading={<User aria-hidden="true" />}
                value={ownerName}
                onChange={(e) => {
                  setOwnerName(e.target.value);
                  clearError("ownerName");
                }}
                disabled={busy}
                maxLength={120}
              />
            </FormField>

            <FormField label="Studio name" error={errors.studioName} required description="What your editors and clients will see.">
              <Input
                name="studioName"
                autoComplete="organization"
                autoFocus
                placeholder="Morgan Photography"
                leading={<Camera aria-hidden="true" />}
                value={studioName}
                onChange={(e) => {
                  setStudioName(e.target.value);
                  clearError("studioName");
                }}
                disabled={busy}
                maxLength={STUDIO_NAME_MAX_LENGTH}
              />
            </FormField>

            {/* Honeypot: people never see or fill this; a bot that does gets a generic refusal. */}
            <div aria-hidden="true" className="pointer-events-none absolute -left-[10000px] top-0 size-px overflow-hidden opacity-0">
              <label>
                Website
                <input name={SIGNUP_HONEYPOT_FIELD} type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
              </label>
            </div>

            <Button type="submit" size="lg" className="mt-1 w-full" loading={busy} leadingIcon={<Sparkles aria-hidden="true" />}>
              {busy ? "Creating your studio…" : "Create your studio"}
            </Button>

            <p className="text-xs text-ink-subtle" data-testid="timezone-note">
              {timezone ? <>Times will show in {describeTimezone(timezone)}. You can change that later in Settings.</> : <>Times will use your studio’s timezone, set later in Settings.</>}
            </p>
          </form>
        </CardContent>
      </Card>

      <div className="flex flex-col items-center gap-2 text-center text-sm text-ink-muted">
        <p>
          Not you?{" "}
          <a href={googleStartHref({ intent: "signup" })} rel="nofollow" className="font-medium text-accent-ink underline-offset-4 hover:underline">
            Use a different Google account
          </a>
        </p>
        <p>
          Already have a studio?{" "}
          <Link href="/login" className="font-medium text-accent-ink underline-offset-4 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
