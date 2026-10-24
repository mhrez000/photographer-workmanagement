"use client";

import * as React from "react";
import Link from "next/link";
import { CircleAlert, Clock, KeyRound, LogIn, LogOut, Mail } from "lucide-react";
import { loginAction, type LoginFormState } from "@/server/actions/auth";
import { INVITED_HINT } from "@/components/auth/auth-helpers";
import { CapsLockHint, useCapsLock } from "@/components/auth/caps-lock";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const INITIAL_STATE: LoginFormState = { error: null, fieldErrors: {}, email: "", retryAfterSeconds: null };

export interface LoginFormProps {
  next?: string;
  expired?: boolean;
  /** Just logged out on this browser (`?logged_out=1`): one quiet line says so (UX-19). */
  loggedOut?: boolean;
  /** Prefill (from "Sign in instead" on the sign-up page, or ?email=). */
  initialEmail?: string;
  /** Don't grab focus (the demo panel above is what the visitor came for: `?demo=1`). */
  quiet?: boolean;
}

const linkClass = "font-medium text-accent-ink underline-offset-4 hover:underline";

function forgotHref(email: string): string {
  const typed = email.trim();
  return typed ? `/forgot-password?email=${encodeURIComponent(typed)}` : "/forgot-password";
}

/**
 * Email + password (server action `loginAction`). One generic error for every refusal — led by the way out ("Forgot
 * your password? Reset it") — a "Try again in N minutes" strip with "reset your password now" when the sign-in limit is
 * reached (UX-02: a reset clears it at once), and a "Caps Lock is on" line under the password while it is on.
 */
export function LoginForm({ next, expired = false, loggedOut = false, initialEmail, quiet = false }: LoginFormProps) {
  const [state, formAction, pending] = React.useActionState(loginAction, INITIAL_STATE);
  const [email, setEmail] = React.useState(state.email || initialEmail || "");
  const [password, setPassword] = React.useState("");
  const caps = useCapsLock();
  const capsId = React.useId();

  // Keep the typed email after a failed attempt (state derived from the action result).
  const [seenState, setSeenState] = React.useState(state);
  if (seenState !== state) {
    setSeenState(state);
    if (state.email) setEmail(state.email);
    setPassword("");
  }

  const throttled = state.retryAfterSeconds !== null;

  return (
    <div className="flex flex-col gap-5">
      <Card className="shadow-md">
        <CardContent className="p-6 first:pt-6 last:pb-6">
          <form action={formAction} className="flex flex-col gap-4" noValidate aria-busy={pending || undefined}>
            {next ? <input type="hidden" name="next" value={next} /> : null}

            {expired && !state.error ? (
              <p className="flex items-start gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm text-ink-secondary" data-login-expired="">
                <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-muted" />
                You’ve been logged out on this device. Sign in again to carry on.
              </p>
            ) : loggedOut && !state.error ? (
              <p role="status" className="flex items-start gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm text-ink-secondary" data-logged-out="">
                <LogOut aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-muted" />
                You’re logged out.
              </p>
            ) : null}

            {state.error ? (
              <div
                role="alert"
                data-login-error={throttled ? "throttled" : "refused"}
                className={cn(
                  "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
                  throttled ? "border-attention/30 bg-attention-soft text-ink" : "border-danger/30 bg-danger-soft text-ink",
                )}
              >
                <CircleAlert aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", throttled ? "text-attention" : "text-danger")} />
                <span>
                  {state.error}
                  {throttled ? (
                    // UX-02: the way out of a lockout — a reset works at once (it forgets the wrong tries).
                    <span className="mt-1 block" data-login-way-out="">
                      Or{" "}
                      <Link href={forgotHref(email)} className={linkClass}>
                        reset your password now
                      </Link>{" "}
                      — you can sign in with the new one straight away.
                    </span>
                  ) : (
                    <>
                      <span className="mt-1 block" data-login-way-out="">
                        Forgot your password?{" "}
                        <Link href={forgotHref(email)} className={linkClass}>
                          Reset it
                        </Link>
                      </span>
                      {/* One short neutral hint for every failed attempt (never says whether the address exists). */}
                      <span className="mt-1 block text-xs text-ink-muted" data-login-hint="">
                        {INVITED_HINT}
                      </span>
                    </>
                  )}
                </span>
              </div>
            ) : null}

            <FormField label="Email" error={state.fieldErrors.email} required>
              <Input
                name="email"
                type="email"
                autoComplete="username"
                inputMode="email"
                autoFocus={!initialEmail && !quiet}
                placeholder="you@studio.com"
                leading={<Mail aria-hidden="true" />}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                invalid={Boolean(state.fieldErrors.email)}
              />
            </FormField>

            <div className="flex flex-col gap-1.5">
              <FormField
                label="Password"
                error={state.fieldErrors.password}
                required
                hint={
                  // A 40px-tall hit area on phones without moving the layout (UX-17).
                  <Link href={forgotHref(email)} className={cn(linkClass, "-my-2.5 inline-flex min-h-10 items-center")} data-forgot-password="">
                    Forgot password?
                  </Link>
                }
              >
                {(field) => (
                  <Input
                    {...field}
                    aria-describedby={[field["aria-describedby"], caps.capsLock ? capsId : null].filter(Boolean).join(" ") || undefined}
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    autoFocus={Boolean(initialEmail) && !quiet}
                    placeholder="••••••••"
                    leading={<KeyRound aria-hidden="true" />}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={caps.onKeyEvent}
                    onKeyUp={caps.onKeyEvent}
                    onBlur={caps.reset}
                    invalid={Boolean(state.fieldErrors.password)}
                  />
                )}
              </FormField>
              <CapsLockHint show={caps.capsLock} id={capsId} />
            </div>

            <Button type="submit" size="lg" className="mt-1 w-full" loading={pending} leadingIcon={<LogIn aria-hidden="true" />}>
              {pending ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <p className="text-center text-sm text-ink-muted">
        New here?{" "}
        <Link href="/signup" className={linkClass}>
          Create your studio
        </Link>
      </p>
    </div>
  );
}
