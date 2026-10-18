"use client";

import * as React from "react";
import Link from "next/link";
import { Mail, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api-client";
import { firstErrors, INVITED_HINT, minutesLeft, retryAfterOf } from "./auth-helpers";
import { DevOnlyLink } from "./dev-only-link";
import { FormAlert } from "./form-alert";

interface ForgotPasswordResult {
  ok: true;
  emailed: boolean;
  /** Local development without an email provider only. */
  resetUrl?: string;
}

/** The one confirmation, whether or not the address has an account (no account enumeration). */
export const RESET_SENT_MESSAGE = "If that email has an account, we’ve sent a link. It expires in 60 minutes.";

export interface ForgotPasswordFormProps {
  /** Prefill (e.g. from the sign-in page). */
  initialEmail?: string;
}

/** POST /api/auth/forgot-password: one field, one calm confirmation. */
export function ForgotPasswordForm({ initialEmail = "" }: ForgotPasswordFormProps) {
  const [email, setEmail] = React.useState(initialEmail);
  const [error, setError] = React.useState<string | undefined>();
  const [formError, setFormError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [sent, setSent] = React.useState<ForgotPasswordResult | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(undefined);
    setFormError(null);
    try {
      const result = await api.post<ForgotPasswordResult>("/api/auth/forgot-password", { email });
      setSent(result);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setFormError(`Too many requests for that email. Try again in ${minutesLeft(retryAfterOf(err))}.`);
      } else if (err instanceof ApiError && err.code === "validation") {
        const fe = firstErrors(err);
        if (fe.email) setError(fe.email);
        else setFormError(err.message);
      } else {
        setFormError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      }
    } finally {
      setPending(false);
    }
  };

  if (sent) {
    return (
      <div className="flex flex-col gap-5">
        <Card className="shadow-md">
          <CardContent className="flex flex-col gap-4 p-6 first:pt-6 last:pb-6">
            <FormAlert tone="success">
              {RESET_SENT_MESSAGE}
              {/* Constant, whatever the address: a pending invitee has no password to reset, only a link to open. */}
              <span className="mt-1 block text-xs text-ink-muted">{INVITED_HINT}</span>
            </FormAlert>
            <p className="text-sm text-ink-muted">
              Check <span className="font-medium text-ink">{email.trim().toLowerCase()}</span>, including the junk folder. Didn’t get it?{" "}
              <button
                type="button"
                onClick={() => {
                  setSent(null);
                  setFormError(null);
                }}
                className="font-medium text-accent-ink underline-offset-4 hover:underline focus-ring rounded-xs"
              >
                Send it again
              </button>
              .
            </p>
            <Button href="/login" variant="outline" className="w-full">
              Back to sign in
            </Button>
          </CardContent>
        </Card>
        {sent.resetUrl ? <DevOnlyLink label="Reset link" url={sent.resetUrl} /> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Card className="shadow-md">
        <CardContent className="p-6 first:pt-6 last:pb-6">
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate aria-busy={pending || undefined}>
            {formError ? <FormAlert tone="attention">{formError}</FormAlert> : null}

            <FormField label="Email" error={error} required description="The address you sign in with.">
              <Input
                name="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                autoFocus
                placeholder="you@studio.com"
                leading={<Mail aria-hidden="true" />}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={pending}
              />
            </FormField>

            <Button type="submit" size="lg" className="mt-1 w-full" loading={pending} leadingIcon={<Send aria-hidden="true" />}>
              {pending ? "Sending…" : "Email me a reset link"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <p className="text-center text-sm text-ink-muted">
        Remembered it?{" "}
        <Link href="/login" className="font-medium text-accent-ink underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
