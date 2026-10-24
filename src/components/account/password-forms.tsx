"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { Eye, EyeOff, KeyRound, LogOut } from "lucide-react";
import { CapsLockHint, useCapsLock } from "@/components/auth/caps-lock";
import { FormAlert } from "@/components/auth/form-alert";
import { useFocusFirstInvalid } from "@/components/auth/use-focus-first-invalid";
import { Button } from "@/components/ui/button";
import { FormField, type FormFieldControlProps } from "@/components/ui/form-field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { GoogleButton } from "@/components/auth/google-button";
import { googleStartHref } from "@/components/auth/google-sign-in";
import { api, ApiError } from "@/lib/api-client";
import { PASSWORD_MIN_LENGTH } from "@/lib/validation/auth";
import { accountErrorMessage, fieldErrorsOf } from "./account-errors";

/* ------------------------------------------------------------------ */
/*  Password input (show / hide + Caps Lock hint)                      */
/* ------------------------------------------------------------------ */

export interface AccountPasswordInputProps extends Partial<FormFieldControlProps> {
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  name?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
}

/** A password box for the My-account cards: show / hide toggle and the quiet "Caps Lock is on" line. */
export function AccountPasswordInput({ value, onChange, autoComplete, name, disabled, autoFocus, placeholder, ...field }: AccountPasswordInputProps) {
  const [visible, setVisible] = React.useState(false);
  const caps = useCapsLock();
  const capsId = React.useId();
  const describedBy = [field["aria-describedby"], caps.capsLock ? capsId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <Input
          {...field}
          aria-describedby={describedBy}
          name={name}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={caps.onKeyEvent}
          onKeyUp={caps.onKeyEvent}
          onBlur={caps.reset}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          placeholder={placeholder}
          disabled={disabled}
          invalid={field["aria-invalid"]}
          spellCheck={false}
          className="pr-10 pointer-coarse:pr-12"
        />
        <IconButton
          label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          // UX-17: 40px on touch screens (the "sm" size is 36px there).
          size="sm"
          className="absolute right-1 top-1/2 -translate-y-1/2 pointer-coarse:size-10"
          onClick={() => setVisible((v) => !v)}
          disabled={disabled}
        >
          {visible ? <EyeOff /> : <Eye />}
        </IconButton>
      </div>
      <CapsLockHint show={caps.capsLock} id={capsId} />
    </div>
  );
}

/** Plain words for the length-based policy (at least 10 characters). */
function strengthHint(value: string): string | undefined {
  if (value.length === 0) return undefined;
  if (value.length < PASSWORD_MIN_LENGTH) {
    const left = PASSWORD_MIN_LENGTH - value.length;
    return `${left} more ${left === 1 ? "character" : "characters"} to go`;
  }
  return value.length < 14 ? "Good — longer is even better" : "Strong";
}

/* ------------------------------------------------------------------ */
/*  Change password (has one)                                          */
/* ------------------------------------------------------------------ */

/**
 * Change your own password (POST /api/auth/change-password): current + new + confirm. Every other device is logged
 * out; this browser stays signed in; "Your password was changed" is emailed (when email is set up). Changing it
 * also cancels a waiting email change.
 */
export function ChangePasswordForm() {
  const router = useRouter();
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const { ref: formRef, focusFirstInvalid } = useFocusFirstInvalid();

  const clear = (key: string) => {
    if (errors[key]) setErrors((e) => ({ ...e, [key]: "" }));
    if (formError) setFormError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const local: Record<string, string> = {};
    if (!current) local.current = "Enter your current password";
    if (next.length < PASSWORD_MIN_LENGTH) local.next = `Use at least ${PASSWORD_MIN_LENGTH} characters`;
    else if (next === current) local.next = "Choose a password different from the current one";
    if (confirm !== next) local.confirm = "Those passwords don’t match";
    setErrors(local);
    setFormError(null);
    if (Object.keys(local).length > 0) {
      focusFirstInvalid();
      return;
    }
    setPending(true);
    try {
      await api.post("/api/auth/change-password", { current, next });
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.success("Password changed", "You’re still signed in here. Every other device was logged out.");
      router.refresh();
    } catch (err) {
      const fields = fieldErrorsOf(err);
      if (Object.keys(fields).length > 0) setErrors(fields);
      else setFormError(accountErrorMessage(err));
      // UX-09: back to the first field with a problem (the fields were disabled while sending).
      focusFirstInvalid();
    } finally {
      setPending(false);
    }
  };

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="flex flex-col gap-4" aria-busy={pending || undefined} data-change-password-form="">
      {/* Helps password managers associate the change with this account. */}
      <input type="text" autoComplete="username" hidden readOnly value="" />
      {formError ? <FormAlert>{formError}</FormAlert> : null}
      <FormField label="Current password" error={errors.current || undefined}>
        {(field) => (
          <AccountPasswordInput
            {...field}
            name="current-password"
            value={current}
            onChange={(v) => {
              setCurrent(v);
              clear("current");
            }}
            autoComplete="current-password"
            disabled={pending}
          />
        )}
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="New password" error={errors.next || undefined} description={strengthHint(next)}>
          {(field) => (
            <AccountPasswordInput
              {...field}
              name="new-password"
              value={next}
              onChange={(v) => {
                setNext(v);
                clear("next");
              }}
              autoComplete="new-password"
              placeholder="At least 10 characters"
              disabled={pending}
            />
          )}
        </FormField>
        <FormField label="Type it again" error={errors.confirm || undefined}>
          {(field) => (
            <AccountPasswordInput
              {...field}
              name="confirm-password"
              value={confirm}
              onChange={(v) => {
                setConfirm(v);
                clear("confirm");
              }}
              autoComplete="new-password"
              disabled={pending}
            />
          )}
        </FormField>
      </div>
      <div className="flex flex-col gap-3 rounded-md bg-surface-sunken px-3 py-2.5 text-sm text-ink-secondary sm:flex-row sm:items-center sm:justify-between">
        <span className="flex items-start gap-2">
          <LogOut aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-muted" />
          Changing it logs you out everywhere else. You stay signed in here.
        </span>
        <Button type="submit" loading={pending} className="shrink-0">
          Change password
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/*  Set a password (has none: Google sign-ups)                         */
/* ------------------------------------------------------------------ */

/**
 * "Set a password" for an account that signs in with Google only (POST /api/auth/set-password). Afterwards the
 * person can also sign in with their email + this password (and change their email, which needs it).
 */
export function SetPasswordForm() {
  const router = useRouter();
  const pathname = usePathname();
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  // SEC-03: adding a password needs a recent sign-in; this holds the server's plain explanation when it was not.
  const [signInAgain, setSignInAgain] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const { ref: formRef, focusFirstInvalid } = useFocusFirstInvalid();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const local: Record<string, string> = {};
    if (password.length < PASSWORD_MIN_LENGTH) local.password = `Use at least ${PASSWORD_MIN_LENGTH} characters`;
    if (confirm !== password) local.confirm = "Those passwords don’t match";
    setErrors(local);
    setFormError(null);
    if (Object.keys(local).length > 0) {
      focusFirstInvalid();
      return;
    }
    setPending(true);
    try {
      await api.post("/api/auth/set-password", { password });
      setPassword("");
      setConfirm("");
      toast.success("Password added", "You can now also sign in with your email and this password.");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403 && (err.details as { action?: unknown } | undefined)?.action === "account.recent_sign_in") {
        setSignInAgain(err.message);
        return;
      }
      const fields = fieldErrorsOf(err);
      if (Object.keys(fields).length > 0) setErrors(fields);
      else setFormError(accountErrorMessage(err));
      // UX-09: back to the first field with a problem (the fields were disabled while sending).
      focusFirstInvalid();
    } finally {
      setPending(false);
    }
  };

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="flex flex-col gap-4" aria-busy={pending || undefined} data-set-password-form="">
      <input type="text" autoComplete="username" hidden readOnly value="" />
      {formError ? <FormAlert>{formError}</FormAlert> : null}
      {signInAgain ? (
        <FormAlert tone="attention">
          <span data-sign-in-again="">{signInAgain}</span>
          <span className="mt-2 flex flex-wrap gap-2">
            <GoogleButton href={googleStartHref({ intent: "signin", next: `${pathname}#password` })} label="Continue with Google" size="md" fullWidth={false} />
          </span>
        </FormAlert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="New password" error={errors.password || undefined} description={strengthHint(password)}>
          {(field) => (
            <AccountPasswordInput
              {...field}
              name="new-password"
              value={password}
              onChange={(v) => {
                setPassword(v);
                if (errors.password) setErrors((x) => ({ ...x, password: "" }));
              }}
              autoComplete="new-password"
              placeholder="At least 10 characters"
              disabled={pending}
            />
          )}
        </FormField>
        <FormField label="Type it again" error={errors.confirm || undefined}>
          {(field) => (
            <AccountPasswordInput
              {...field}
              name="confirm-password"
              value={confirm}
              onChange={(v) => {
                setConfirm(v);
                if (errors.confirm) setErrors((x) => ({ ...x, confirm: "" }));
              }}
              autoComplete="new-password"
              disabled={pending}
            />
          )}
        </FormField>
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={pending} leadingIcon={<KeyRound aria-hidden="true" />}>
          Set password
        </Button>
      </div>
    </form>
  );
}
