"use client";

import * as React from "react";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { PASSWORD_MIN_LENGTH } from "@/lib/validation/auth";
import { cn } from "@/lib/utils";
import { CapsLockHint, useCapsLock } from "./caps-lock";

export interface PasswordFieldProps {
  label?: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  name?: string;
  autoComplete?: "new-password" | "current-password";
  autoFocus?: boolean;
  /** Shows the length-based strength hint under the field (new passwords). */
  strength?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** Small text on the right of the label (e.g. a "Forgot password?" link). */
  hint?: React.ReactNode;
}

/** Plain words for the length-based policy (src/lib/validation/auth.ts: at least 10 characters). */
export function passwordStrength(value: string): { level: 0 | 1 | 2 | 3; label: string } {
  const length = value.length;
  if (length === 0) return { level: 0, label: `Use at least ${PASSWORD_MIN_LENGTH} characters — a short sentence works well` };
  if (length < PASSWORD_MIN_LENGTH) {
    const left = PASSWORD_MIN_LENGTH - length;
    return { level: 1, label: `${left} more ${left === 1 ? "character" : "characters"} to go` };
  }
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  if (length >= 14 || (length >= 12 && kinds >= 3)) return { level: 3, label: "Strong password" };
  return { level: 2, label: "Good — longer is stronger" };
}

const BAR_TONES = ["bg-border", "bg-danger", "bg-attention", "bg-success"] as const;

/**
 * Password input with a show / hide toggle, a quiet "Caps Lock is on" line while Caps Lock is on (docs/ACCOUNTS.md:
 * the most common reason a correct password "doesn't work"), and (optionally) the strength hint.
 */
export function PasswordField({
  label = "Password",
  value,
  onChange,
  error,
  name = "password",
  autoComplete = "new-password",
  autoFocus,
  strength = false,
  placeholder = "At least 10 characters",
  disabled,
  hint,
}: PasswordFieldProps) {
  const [shown, setShown] = React.useState(false);
  const meter = strength ? passwordStrength(value) : null;
  const meterId = React.useId();
  const capsId = React.useId();
  const caps = useCapsLock();

  return (
    <div className="flex flex-col gap-1.5">
      <FormField label={label} error={error} required hint={hint}>
        {(field) => (
          <div className="relative w-full">
            <Input
              {...field}
              aria-describedby={[field["aria-describedby"], meter ? meterId : null, caps.capsLock ? capsId : null].filter(Boolean).join(" ") || undefined}
              name={name}
              type={shown ? "text" : "password"}
              autoComplete={autoComplete}
              autoFocus={autoFocus}
              placeholder={placeholder}
              leading={<KeyRound aria-hidden="true" />}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={caps.onKeyEvent}
              onKeyUp={caps.onKeyEvent}
              onBlur={caps.reset}
              invalid={Boolean(error)}
              disabled={disabled}
              className="pr-11"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => setShown((s) => !s)}
              aria-label={shown ? "Hide password" : "Show password"}
              aria-pressed={shown}
              className="focus-ring absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-ink-subtle hover:text-ink"
            >
              {shown ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
            </button>
          </div>
        )}
      </FormField>
      <CapsLockHint show={caps.capsLock} id={capsId} />
      {meter && !error ? (
        <div id={meterId} className="flex flex-col gap-1.5" aria-live="polite">
          <div className="flex gap-1" aria-hidden="true">
            {[1, 2, 3].map((step) => (
              <span
                key={step}
                className={cn("h-1 flex-1 rounded-full transition-colors duration-(--motion-fast)", step <= meter.level ? BAR_TONES[meter.level] : "bg-border")}
              />
            ))}
          </div>
          <p className={cn("text-xs", meter.level === 1 ? "text-ink-secondary" : "text-ink-muted")}>{meter.label}</p>
        </div>
      ) : null}
    </div>
  );
}
