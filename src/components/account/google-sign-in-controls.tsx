"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CircleCheck, Unlink } from "lucide-react";
import { FormAlert } from "@/components/auth/form-alert";
import { GoogleLogo } from "@/components/auth/google-logo";
import { googleResultMessage, type GoogleResultMessage } from "@/components/auth/google-sign-in";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { toast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api-client";
import { accountErrorMessage, fieldErrorsOf } from "./account-errors";
import { AccountPasswordInput } from "./password-forms";

export interface GoogleSignInControlsProps {
  /** GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are set (Connect is offered). */
  configured: boolean;
  connected: boolean;
  /** The connected Google address. */
  googleEmail: string | null;
  /** Disconnect is offered only with a password (otherwise the account would have no way in). */
  hasPassword: boolean;
}

interface DisconnectResult {
  ok: true;
  disconnected: boolean;
}

/**
 * The Google card's interactive part: the `?google=<result>` message of a Connect round trip, "Connected as x" with
 * Disconnect (one confirming press; POST /api/auth/google/disconnect → toast + fresh page), or Connect Google — which
 * asks for the current password first (POST /api/auth/google/connect, SEC-03) and then opens Google's page.
 */
export function GoogleSignInControls({ configured, connected, googleEmail, hasPassword }: GoogleSignInControlsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const fromUrl = googleResultMessage(params.get("google"), "account");
  const [local, setLocal] = React.useState<GoogleResultMessage | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const message = local ?? fromUrl;

  const disconnect = async () => {
    if (pending) return;
    setPending(true);
    setLocal(null);
    try {
      await api.post<DisconnectResult>("/api/auth/google/disconnect");
      setConfirming(false);
      setLocal(googleResultMessage("disconnected", "account"));
      toast({ title: "Google disconnected", variant: "success" });
      // Drop any ?google=connected from the address so a reload never shows a stale message.
      router.replace(`${pathname}#google`, { scroll: false });
      router.refresh();
    } catch (err) {
      setLocal({ tone: "danger", text: err instanceof ApiError ? err.message : "Something went wrong. Please try again." });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-google-controls="">
      {message ? <FormAlert tone={message.tone}>{message.text}</FormAlert> : null}

      {connected ? (
        <>
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-secondary">
            <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-success" />
            <span>Connected as</span>
            <span className="min-w-0 break-words font-medium text-ink" data-google-email="">
              {googleEmail}
            </span>
          </p>
          {!configured ? (
            <p className="text-sm text-ink-muted" data-google-off="">
              {hasPassword
                ? "Continue with Google is turned off on Proofline right now, so sign in with your email and password."
                : "Continue with Google is turned off on Proofline right now. Set a password above so you can still sign in."}
            </p>
          ) : null}
          {!configured && !hasPassword ? null : hasPassword ? (
            confirming ? (
              <div className="flex flex-col gap-3 rounded-md border border-border bg-surface-sunken p-3" role="group" aria-labelledby="google-disconnect-question">
                <p id="google-disconnect-question" className="text-sm text-ink">
                  Disconnect Google? You’ll sign in with your email and password. You can connect it again at any time.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="danger" onClick={disconnect} loading={pending} leadingIcon={<Unlink aria-hidden="true" />}>
                    {pending ? "Disconnecting…" : "Disconnect Google"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>
                    Keep it
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                <Button size="sm" variant="outline" onClick={() => setConfirming(true)} leadingIcon={<Unlink aria-hidden="true" />}>
                  Disconnect
                </Button>
              </div>
            )
          ) : (
            <p className="text-sm text-ink-muted">Google is how you sign in right now. To disconnect it, set a password first.</p>
          )}
        </>
      ) : configured ? (
        hasPassword ? (
          <ConnectGoogleForm />
        ) : (
          <p className="text-sm text-ink-muted">Set a password above first, then you can connect Google.</p>
        )
      ) : null}
    </div>
  );
}

/**
 * "Connect Google": first press shows one password box ("To keep your account safe, enter your password"), then
 * POST /api/auth/google/connect and off to Google's page. A wrong password stays on the field, focused.
 */
function ConnectGoogleForm() {
  const [open, setOpen] = React.useState(false);
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const inputRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    // Back from Google (bfcache) restores the page as it was: make the form usable again.
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setPending(false);
    };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  const focusPassword = () => {
    requestAnimationFrame(() => inputRef.current?.querySelector<HTMLInputElement>("input")?.focus());
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    if (!password) {
      setError("Enter your current password");
      focusPassword();
      return;
    }
    setPending(true);
    setError(null);
    setFormError(null);
    try {
      const result = await api.post<{ redirectTo: string }>("/api/auth/google/connect", { password });
      // Stay "pending" until Google's page takes over.
      window.location.assign(result.redirectTo);
    } catch (err) {
      setPending(false);
      const fields = fieldErrorsOf(err);
      if (fields.password) setError(fields.password);
      else setFormError(accountErrorMessage(err));
      focusPassword();
    }
  };

  if (!open) {
    return (
      <>
        <p className="text-sm text-ink-secondary">Not connected. Connect your Google account to sign in without typing a password.</p>
        <div>
          <Button
            variant="outline"
            className="gap-2.5 [&_svg[data-google-logo]]:size-5"
            onClick={() => {
              setOpen(true);
              focusPassword();
            }}
            data-connect-google=""
          >
            <GoogleLogo />
            <span>Connect Google</span>
          </Button>
        </div>
      </>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-busy={pending || undefined} data-connect-google-form="">
      <input type="text" autoComplete="username" hidden readOnly value="" />
      {formError ? <FormAlert>{formError}</FormAlert> : null}
      <div ref={inputRef}>
        <FormField label="Your password" description="To keep your account safe, enter your password before adding Google." error={error ?? undefined}>
          {(field) => (
            <AccountPasswordInput
              {...field}
              name="current-password"
              value={password}
              onChange={(v) => {
                setPassword(v);
                if (error) setError(null);
              }}
              autoComplete="current-password"
              autoFocus
            />
          )}
        </FormField>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="outline" loading={pending} className="gap-2.5 [&_svg[data-google-logo]]:size-5" data-connect-google-continue="">
          {pending ? null : <GoogleLogo />}
          <span>{pending ? "Opening Google…" : "Continue to Google"}</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setPassword("");
            setError(null);
            setFormError(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
