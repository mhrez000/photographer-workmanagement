"use client";

import * as React from "react";
import Link from "next/link";
import { CircleAlert, Clock, KeyRound, LogIn, Mail } from "lucide-react";
import { loginAction, type LoginFormState } from "@/server/actions/auth";
import { INVITED_HINT } from "@/components/auth/auth-helpers";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from "@/lib/constants";
import { cn } from "@/lib/utils";

const INITIAL_STATE: LoginFormState = { error: null, fieldErrors: {}, email: "", retryAfterSeconds: null };

export interface LoginFormProps {
  next?: string;
  expired?: boolean;
  /** Prefill (from "Sign in instead" on the sign-up page). */
  initialEmail?: string;
  /** Offer the seeded demo accounts (hidden for invitees and for browsers that created a real studio). */
  showDemo?: boolean;
  /** `?demo=1` from the landing page: the demo box comes first, highlighted and scrolled into view. */
  demoFirst?: boolean;
}

const linkClass = "font-medium text-accent-ink underline-offset-4 hover:underline";

export function LoginForm({ next, expired = false, initialEmail, showDemo = true, demoFirst = false }: LoginFormProps) {
  const [state, formAction, pending] = React.useActionState(loginAction, INITIAL_STATE);
  const [email, setEmail] = React.useState(state.email || initialEmail || "");
  const [password, setPassword] = React.useState("");
  const passwordRef = React.useRef<HTMLInputElement>(null);
  const demoRef = React.useRef<HTMLElement>(null);

  // Keep the typed email after a failed attempt (state derived from the action result).
  const [seenState, setSeenState] = React.useState(state);
  if (seenState !== state) {
    setSeenState(state);
    if (state.email) setEmail(state.email);
    setPassword("");
  }

  React.useEffect(() => {
    if (demoFirst) demoRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [demoFirst]);

  const fillDemo = (demoEmail: string) => {
    setEmail(demoEmail);
    setPassword(DEMO_PASSWORD);
    passwordRef.current?.focus();
  };

  const throttled = state.retryAfterSeconds !== null;

  const demoBox = showDemo ? (
    <section
      ref={demoRef}
      id="demo-accounts"
      aria-labelledby="demo-accounts-title"
      data-demo-accounts=""
      className={cn("scroll-mt-6 rounded-lg border border-dashed p-4", demoFirst ? "border-accent/50 bg-accent-soft/40 shadow-xs" : "border-border bg-surface-sunken")}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="demo-accounts-title" className="text-sm font-semibold text-ink">
          Demo accounts
        </h2>
        <span className="text-xs text-ink-muted">
          password <code className="font-mono text-ink-secondary">{DEMO_PASSWORD}</code>
        </span>
      </div>
      <ul className="mt-3 flex flex-col gap-1">
        {DEMO_ACCOUNTS.map((account) => (
          <li key={account.email}>
            <button
              type="button"
              onClick={() => fillDemo(account.email)}
              className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface focus-ring sm:flex-row sm:items-center sm:justify-between sm:gap-3"
            >
              <span className="min-w-0 truncate font-mono text-xs text-ink">{account.email}</span>
              <span className="min-w-0 text-xs text-ink-muted sm:shrink-0 sm:text-right">
                <span className="font-medium text-ink-secondary">{account.shownAs}</span> · {account.note}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-ink-subtle">Click an account to fill the form{demoFirst ? ", then press Sign in" : ""}.</p>
    </section>
  ) : null;

  return (
    <div className="flex flex-col gap-5">
      {demoFirst ? demoBox : null}
      <Card className="shadow-md">
        <CardContent className="p-6 first:pt-6 last:pb-6">
          <form action={formAction} className="flex flex-col gap-4" noValidate>
            {next ? <input type="hidden" name="next" value={next} /> : null}

            {expired && !state.error ? (
              <p className="flex items-start gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm text-ink-secondary">
                <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-muted" />
                Your session ended. Sign in again to continue.
              </p>
            ) : null}

            {state.error ? (
              <div
                role="alert"
                className={cn(
                  "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
                  throttled ? "border-attention/30 bg-attention-soft text-ink" : "border-danger/30 bg-danger-soft text-ink",
                )}
              >
                <CircleAlert aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", throttled ? "text-attention" : "text-danger")} />
                <span>
                  {state.error}
                  {!throttled ? (
                    // One neutral hint for every failed attempt (never says whether the address exists): an invitee who
                    // has not opened their link has no password yet; a client's studio may have closed the portal.
                    <span className="mt-1 block text-xs text-ink-muted" data-login-hint="">
                      {INVITED_HINT} Client of a studio? Your studio may have turned off portal access.
                    </span>
                  ) : null}
                </span>
              </div>
            ) : null}

            <FormField label="Email" error={state.fieldErrors.email} required>
              <Input
                name="email"
                type="email"
                autoComplete="username"
                inputMode="email"
                autoFocus={!initialEmail && !demoFirst}
                placeholder="you@studio.com"
                leading={<Mail aria-hidden="true" />}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                invalid={Boolean(state.fieldErrors.email)}
              />
            </FormField>

            <FormField
              label="Password"
              error={state.fieldErrors.password}
              required
              hint={
                <Link href={email.trim() ? `/forgot-password?email=${encodeURIComponent(email.trim())}` : "/forgot-password"} className={linkClass}>
                  Forgot password?
                </Link>
              }
            >
              <Input
                ref={passwordRef}
                name="password"
                type="password"
                autoComplete="current-password"
                autoFocus={Boolean(initialEmail)}
                placeholder="••••••••"
                leading={<KeyRound aria-hidden="true" />}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                invalid={Boolean(state.fieldErrors.password)}
              />
            </FormField>

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

      {demoFirst ? null : demoBox}
    </div>
  );
}
