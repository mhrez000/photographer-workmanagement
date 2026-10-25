"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api, ApiError } from "@/lib/api-client";
import { DEAD_LINK_CHECK, minutesLeft, retryAfterOf } from "./auth-helpers";
import { FormAlert } from "./form-alert";
import { InvalidLinkCard } from "./invalid-link-card";

/** POST /api/auth/email-change/confirm → `{ data }` (src/app/api/auth/email-change/confirm/route.ts). */
interface ConfirmEmailChangeResult {
  ok: true;
  email: string;
  signedIn: boolean;
  redirectTo: string;
}

/** Body of a dead email-change link (unknown, used, expired, replaced by a newer one, cancelled). */
export const INVALID_EMAIL_CHANGE_BODY = `${DEAD_LINK_CHECK}. If you already confirmed the change, you’re all set — otherwise ask for a new link on your account page. These links work once and last 24 hours.`;

export interface ConfirmEmailChangeFormProps {
  /** From `?token=`; null when missing or malformed (the page already checked the shape). */
  token: string | null;
  /** Where the dead-link card's button goes: the visitor's own account page when signed in, else sign in. */
  fallbackHref: string;
  fallbackLabel: string;
}

/**
 * The one button on /change-email: confirming happens on a PRESS (a POST with the token in the body), never when
 * the page opens — mail scanners open links. Success → "Email changed" + Continue (My account when this browser is
 * signed in as the person, sign in otherwise). A dead link → the dead-link card; the address taken by another
 * account meanwhile → a plain explanation (nothing changed).
 */
export function ConfirmEmailChangeForm({ token, fallbackHref, fallbackLabel }: ConfirmEmailChangeFormProps) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [invalid, setInvalid] = React.useState(token === null);
  const [taken, setTaken] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<ConfirmEmailChangeResult | null>(null);

  if (invalid) {
    return (
      <InvalidLinkCard
        title="This email change link is no longer valid"
        body={INVALID_EMAIL_CHANGE_BODY}
        actionHref={fallbackHref}
        actionLabel={fallbackLabel}
      />
    );
  }

  if (taken) {
    return (
      <Card className="shadow-md" data-email-change-taken="">
        <CardContent className="flex flex-col items-start gap-4 p-6 first:pt-6 last:pb-6">
          <FormAlert>{taken}</FormAlert>
          <p className="text-sm text-ink-muted">Your email didn’t change. Choose a different address on your account page.</p>
          <Button href={fallbackHref} size="lg" className="w-full">
            {fallbackLabel}
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (done) {
    return (
      <Card className="shadow-md" data-email-change-done="">
        <CardContent className="flex flex-col items-start gap-4 p-6 first:pt-6 last:pb-6">
          <div className="flex size-10 items-center justify-center rounded-full bg-success-soft text-success ring-1 ring-inset ring-success/20">
            <MailCheck aria-hidden="true" className="size-5" />
          </div>
          <div role="status">
            <h2 className="text-md font-semibold text-ink">Email changed</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Your Proofline account now uses <span className="break-all font-medium text-ink">{done.email}</span>. Use it the next time you sign in.
            </p>
          </div>
          <Button size="lg" className="w-full" autoFocus onClick={() => router.push(done.redirectTo || "/login")} trailingIcon={<ArrowRight aria-hidden="true" />}>
            {done.signedIn ? "Continue" : "Sign in"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const confirm = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || !token) return;
    setPending(true);
    setFormError(null);
    try {
      const result = await api.post<ConfirmEmailChangeResult>("/api/auth/email-change/confirm", { token });
      setDone(result);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation") {
        const reason = (err.details as { reason?: unknown } | undefined)?.reason;
        if (reason === "email_taken") setTaken(err.message);
        else setInvalid(true);
      } else if (err instanceof ApiError && err.code === "rate_limited") {
        setFormError(`Too many tries. Try again in ${minutesLeft(retryAfterOf(err))}.`);
      } else {
        setFormError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <Card className="shadow-md">
      <CardContent className="p-6 first:pt-6 last:pb-6">
        <form onSubmit={confirm} className="flex flex-col gap-4" aria-busy={pending || undefined}>
          {formError ? <FormAlert>{formError}</FormAlert> : null}
          <p className="text-sm text-ink-secondary">Press the button to start using your new email address for Proofline. Your old address will get a short note to say it changed.</p>
          <Button type="submit" size="lg" className="w-full" loading={pending} autoFocus leadingIcon={<MailCheck aria-hidden="true" />}>
            {pending ? "Confirming…" : "Confirm my new email"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
