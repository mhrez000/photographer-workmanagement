"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Camera, Mail, Sparkles, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api-client";
import { STUDIO_NAME_MAX_LENGTH } from "@/lib/constants";
import { PASSWORD_MIN_LENGTH } from "@/lib/validation/auth";
import { browserTimezone, describeTimezone, firstErrors, minutesLeft, retryAfterOf } from "./auth-helpers";
import { FormAlert } from "./form-alert";
import { PasswordField } from "./password-field";

interface SignUpResult {
  organisationId: string;
  slug: string;
  user: { id: string; name: string; email: string; role: string };
  redirectTo: string;
}

type ErrorKey = "ownerName" | "email" | "password" | "studioName" | "timezone";
type Errors = Partial<Record<ErrorKey, string>>;

/** The server's "taken email" message ends with "Try signing in." — we add the link. */
const TAKEN_EMAIL = /already in use/i;

const subscribeNever = () => () => {};
const noTimezone = () => null;

/**
 * "Create your studio" (POST /api/auth/signup): name, email, password, studio name; the timezone is
 * detected from the browser and sent along. Field errors appear inline and clear as the field is edited;
 * the button stays disabled until the password is long enough (the meter says how many to go); a taken
 * email offers "Sign in instead"; a 429 says how long to wait. Success → the new owner's Home.
 */
export function SignUpForm() {
  const router = useRouter();
  const [ownerName, setOwnerName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [studioName, setStudioName] = React.useState("");
  // Browser-only (Intl); the server snapshot is null so the first paint matches.
  const detectedTimezone = React.useSyncExternalStore(subscribeNever, browserTimezone, noTimezone);
  const [timezoneRejected, setTimezoneRejected] = React.useState(false);
  const timezone = timezoneRejected ? null : detectedTimezone;
  const [errors, setErrors] = React.useState<Errors>({});
  const [formError, setFormError] = React.useState<{ tone: "danger" | "attention"; text: string } | null>(null);
  const [pending, setPending] = React.useState(false);
  const [done, setDone] = React.useState(false);

  const tooShort = password.length < PASSWORD_MIN_LENGTH;
  const clearError = (key: ErrorKey) => {
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || done || tooShort) return;
    setPending(true);
    setErrors({});
    setFormError(null);
    try {
      const result = await api.post<SignUpResult>("/api/auth/signup", {
        ownerName,
        email,
        password,
        studioName,
        ...(timezone ? { timezone } : {}),
      });
      setDone(true);
      router.push(result.redirectTo || "/home");
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setFormError({ tone: "attention", text: `Too many sign-ups from this network. Try again in ${minutesLeft(retryAfterOf(err))}.` });
      } else if (err instanceof ApiError && err.code === "validation") {
        const fe = firstErrors(err);
        if (Object.keys(fe).length === 0) setFormError({ tone: "danger", text: err.message });
        else setErrors(fe);
        // A bad timezone guess must never block sign-up: drop it and let the server default apply next time.
        if (fe.timezone) setTimezoneRejected(true);
      } else {
        setFormError({ tone: "danger", text: err instanceof ApiError ? err.message : "Something went wrong. Please try again." });
      }
      setPending(false);
    }
  };

  const busy = pending || done;

  return (
    <div className="flex flex-col gap-5">
      <Card className="shadow-md">
        <CardContent className="p-6 first:pt-6 last:pb-6">
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate aria-busy={busy || undefined}>
            {formError ? <FormAlert tone={formError.tone}>{formError.text}</FormAlert> : null}

            <FormField label="Your name" error={errors.ownerName} required>
              <Input
                name="ownerName"
                autoComplete="name"
                autoFocus
                placeholder="Alex Morgan"
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

            <FormField
              label="Email"
              required
              error={
                errors.email ? (
                  <>
                    {errors.email}
                    {TAKEN_EMAIL.test(errors.email) ? (
                      <>
                        {" "}
                        <Link href={`/login?email=${encodeURIComponent(email.trim())}`} className="font-medium text-accent-ink underline-offset-4 hover:underline">
                          Sign in instead
                        </Link>
                      </>
                    ) : null}
                  </>
                ) : undefined
              }
            >
              <Input
                name="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                placeholder="you@studio.com"
                leading={<Mail aria-hidden="true" />}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  clearError("email");
                }}
                disabled={busy}
              />
            </FormField>

            <PasswordField
              value={password}
              onChange={(v) => {
                setPassword(v);
                clearError("password");
              }}
              error={errors.password}
              strength
              autoComplete="new-password"
              disabled={busy}
            />

            <FormField label="Studio name" error={errors.studioName} required description="What your editors and clients will see.">
              <Input
                name="studioName"
                autoComplete="organization"
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

            <Button type="submit" size="lg" className="mt-1 w-full" loading={busy} disabled={tooShort} leadingIcon={<Sparkles aria-hidden="true" />}>
              {busy ? "Creating your studio…" : "Create your studio"}
            </Button>

            <p className="text-xs text-ink-subtle" data-testid="timezone-note">
              {timezone ? <>Times will show in {describeTimezone(timezone)} — you can change that later in Settings.</> : <>Times will use your studio’s timezone, set later in Settings.</>}
            </p>
          </form>
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
