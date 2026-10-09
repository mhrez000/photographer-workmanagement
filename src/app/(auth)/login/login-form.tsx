"use client";

import * as React from "react";
import { CircleAlert, Clock, KeyRound, LogIn, Mail } from "lucide-react";
import { loginAction, type LoginFormState } from "@/server/actions/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const INITIAL_STATE: LoginFormState = { error: null, fieldErrors: {}, email: "", retryAfterSeconds: null };

const DEMO_PASSWORD = "Password123!";
const DEMO_ACCOUNTS = [
  { email: "owner@studio.test", role: "Owner", note: "everything" },
  { email: "manager1@studio.test", role: "Manager", note: "runs production" },
  { email: "photographer01@studio.test", role: "Photographer", note: "own jobs" },
  { email: "editor01@studio.test", role: "Editor", note: "assigned jobs" },
] as const;

export interface LoginFormProps {
  next?: string;
  expired?: boolean;
}

export function LoginForm({ next, expired = false }: LoginFormProps) {
  const [state, formAction, pending] = React.useActionState(loginAction, INITIAL_STATE);
  const [email, setEmail] = React.useState(state.email);
  const [password, setPassword] = React.useState("");
  const passwordRef = React.useRef<HTMLInputElement>(null);

  // Keep the typed email after a failed attempt (state derived from the action result).
  const [seenState, setSeenState] = React.useState(state);
  if (seenState !== state) {
    setSeenState(state);
    if (state.email) setEmail(state.email);
    setPassword("");
  }

  const fillDemo = (demoEmail: string) => {
    setEmail(demoEmail);
    setPassword(DEMO_PASSWORD);
    passwordRef.current?.focus();
  };

  const throttled = state.retryAfterSeconds !== null;

  return (
    <div className="flex flex-col gap-5">
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
                <span>{state.error}</span>
              </div>
            ) : null}

            <FormField label="Email" error={state.fieldErrors.email} required>
              <Input
                name="email"
                type="email"
                autoComplete="username"
                inputMode="email"
                autoFocus
                placeholder="you@studio.com"
                leading={<Mail aria-hidden="true" />}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                invalid={Boolean(state.fieldErrors.email)}
              />
            </FormField>

            <FormField label="Password" error={state.fieldErrors.password} required>
              <Input
                ref={passwordRef}
                name="password"
                type="password"
                autoComplete="current-password"
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

      <section aria-labelledby="demo-accounts" className="rounded-lg border border-dashed border-border bg-surface-sunken p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="demo-accounts" className="text-sm font-semibold text-ink">
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
                className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface focus-ring"
              >
                <span className="min-w-0 truncate font-mono text-xs text-ink">{account.email}</span>
                <span className="shrink-0 text-xs text-ink-muted">
                  {account.role} · {account.note}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-ink-subtle">Click an account to fill the form.</p>
      </section>
    </div>
  );
}
