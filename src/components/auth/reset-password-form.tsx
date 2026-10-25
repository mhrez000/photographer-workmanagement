"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api-client";
import { PASSWORD_MIN_LENGTH } from "@/lib/validation/auth";
import { firstErrors, INVALID_RESET_BODY } from "./auth-helpers";
import { AuthPageHeader } from "./auth-page-header";
import { FormAlert } from "./form-alert";
import { InvalidLinkCard } from "./invalid-link-card";
import { PasswordField } from "./password-field";

interface ResetPasswordResult {
  ok: true;
  redirectTo: string;
}

export interface ResetPasswordFormProps {
  /** From `?token=`; null when missing or malformed (the page already checked the shape). */
  token: string | null;
}

/** The page heading + tab title for a live link and a dead one (UX-08: the dead state never says "Choose a new password"). */
const LIVE_TITLE = "Choose a new password";
const DEAD_TITLE = "Reset your password";

/**
 * POST /api/auth/reset-password: new password + "Type it again". The button stays disabled until the password is
 * long enough (the meter under the field says how many characters to go); a field error clears as soon as
 * the person types again, so the meter comes back. An unknown / expired / used link turns the page into
 * "Reset your password" + "This reset link is no longer valid" with a way to request a fresh one (heading and tab
 * title follow). Success → signed in, with a toast saying the new password is set (UX-19).
 */
export function ResetPasswordForm({ token }: ResetPasswordFormProps) {
  const router = useRouter();
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [errors, setErrors] = React.useState<{ password?: string; confirm?: string }>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [invalid, setInvalid] = React.useState(token === null);
  const [pending, setPending] = React.useState(false);
  const [done, setDone] = React.useState(false);

  if (invalid) {
    return (
      <div className="flex flex-col gap-8">
        <DocumentTitle title={DEAD_TITLE} />
        <AuthPageHeader title={DEAD_TITLE} />
        <InvalidLinkCard
          title="This reset link is no longer valid"
          body={INVALID_RESET_BODY}
          actionHref="/forgot-password"
          actionLabel="Request a new link"
          footer={
            <>
              Remembered it?{" "}
              <Link href="/login" className="font-medium text-accent-ink underline-offset-4 hover:underline">
                Sign in
              </Link>
            </>
          }
        />
      </div>
    );
  }

  const tooShort = password.length < PASSWORD_MIN_LENGTH;

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || done || !token || tooShort) return;
    if (password !== confirm) {
      setErrors({ confirm: "Those passwords don’t match" });
      return;
    }
    setPending(true);
    setErrors({});
    setFormError(null);
    try {
      const result = await api.post<ResetPasswordResult>("/api/auth/reset-password", { token, password });
      setDone(true);
      toast.success("Your new password is set", "You’re signed in.");
      router.push(result.redirectTo || "/");
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation") {
        const fe = firstErrors(err);
        if (fe.password) setErrors({ password: fe.password });
        else setInvalid(true);
      } else {
        setFormError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      }
      setPending(false);
    }
  };

  const busy = pending || done;

  return (
    <div className="flex flex-col gap-8">
      <AuthPageHeader title={LIVE_TITLE} lede="Make it at least 10 characters. A short sentence you’ll remember works well." />
      <div className="flex flex-col gap-5">
        <Card className="shadow-md">
          <CardContent className="p-6 first:pt-6 last:pb-6">
            <form onSubmit={submit} className="flex flex-col gap-4" noValidate aria-busy={busy || undefined}>
              {formError ? <FormAlert>{formError}</FormAlert> : null}

              <PasswordField
                label="New password"
                value={password}
                onChange={(v) => {
                  setPassword(v);
                  if (errors.password) setErrors((e) => ({ ...e, password: undefined }));
                }}
                error={errors.password}
                strength
                autoFocus
                disabled={busy}
              />
              <PasswordField
                label="Type it again"
                name="confirm"
                value={confirm}
                onChange={(v) => {
                  setConfirm(v);
                  if (errors.confirm) setErrors((e) => ({ ...e, confirm: undefined }));
                }}
                error={errors.confirm}
                disabled={busy}
              />

              <Button type="submit" size="lg" className="mt-1 w-full" loading={busy} disabled={tooShort} leadingIcon={<KeyRound aria-hidden="true" />}>
                {busy ? "Saving…" : "Set new password"}
              </Button>
              <p className="text-xs text-ink-subtle">You’ll be signed in here, and logged out everywhere else.</p>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-sm text-ink-muted">
          Changed your mind?{" "}
          <Link href="/login" className="font-medium text-accent-ink underline-offset-4 hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

/** Keeps the tab title in step with what the page says (the server title is for the first render only). */
function DocumentTitle({ title }: { title: string }) {
  React.useEffect(() => {
    const previous = document.title;
    document.title = previous.includes("Proofline") ? previous.replace(/^[^|·—-]+/, `${title} `) : title;
  }, [title]);
  return null;
}
