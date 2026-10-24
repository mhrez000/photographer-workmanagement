"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Mail, User, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api-client";
import { PASSWORD_MIN_LENGTH } from "@/lib/validation/auth";
import { firstErrors, invalidInviteBody } from "./auth-helpers";
import { AuthPageHeader } from "./auth-page-header";
import { FormAlert } from "./form-alert";
import { InvalidLinkCard } from "./invalid-link-card";
import { PasswordField } from "./password-field";

interface AcceptInviteResult {
  user: { id: string; name: string; email: string; role: string };
  redirectTo: string;
}

export interface AcceptInviteFormProps {
  token: string;
  studioName: string;
  email: string;
  /** Prefilled by whoever sent the invite; the person can correct it. */
  initialName: string;
  /** The page heading (server-rendered). Swapped for "This invite link is no longer valid" when the link dies mid-visit. */
  header: React.ReactNode;
  /**
   * Another way to join, rendered under the password card (the invite page passes `<ContinueWithGoogle intent="invite" />`,
   * a server component, as an element). Hidden with the form when the link dies mid-visit.
   */
  alternative?: React.ReactNode;
}

/**
 * POST /api/auth/invite/:token/accept: confirm the name, choose a password, join. The email is fixed
 * (it is what the invite was sent to). The name is always sent, trimmed, so clearing a wrong prefill is an
 * error rather than a silent keep. Join is disabled until the password is long enough (no round trip for a
 * known failure). A link that died in the meantime swaps the whole screen for the friendly dead-link card.
 */
export function AcceptInviteForm({ token, studioName, email, initialName, header, alternative }: AcceptInviteFormProps) {
  const router = useRouter();
  const [name, setName] = React.useState(initialName);
  const [password, setPassword] = React.useState("");
  const [errors, setErrors] = React.useState<{ name?: string; password?: string }>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [invalid, setInvalid] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [done, setDone] = React.useState(false);

  if (invalid) {
    return (
      <div className="flex flex-col gap-8">
        <AuthPageHeader title="This invite link is no longer valid" />
        <InvalidLinkCard body={invalidInviteBody(studioName)} actionHref="/login?from=invite" actionLabel="Sign in" />
      </div>
    );
  }

  const tooShort = password.length < PASSWORD_MIN_LENGTH;

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || done) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setErrors({ name: "Enter your name" });
      return;
    }
    if (tooShort) return;
    setPending(true);
    setErrors({});
    setFormError(null);
    try {
      const result = await api.post<AcceptInviteResult>(`/api/auth/invite/${encodeURIComponent(token)}/accept`, { password, name: trimmed });
      setDone(true);
      router.push(result.redirectTo || "/");
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation") {
        const fe = firstErrors(err);
        if (fe.password || fe.name) setErrors({ password: fe.password, name: fe.name });
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
      {header}
      <div className="flex flex-col gap-5">
        <Card className="shadow-md">
          <CardContent className="p-6 first:pt-6 last:pb-6">
            <form onSubmit={submit} className="flex flex-col gap-4" noValidate aria-busy={busy || undefined}>
              {formError ? <FormAlert>{formError}</FormAlert> : null}

              <FormField label="Email" description="The invite was sent to this address.">
                <Input name="email" type="email" value={email} readOnly leading={<Mail aria-hidden="true" />} autoComplete="username" />
              </FormField>

              <FormField label="Your name" error={errors.name} required>
                <Input
                  name="name"
                  autoComplete="name"
                  autoFocus
                  leading={<User aria-hidden="true" />}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (errors.name) setErrors((prev) => ({ ...prev, name: undefined }));
                  }}
                  disabled={busy}
                  maxLength={120}
                />
              </FormField>

              <PasswordField
                label="Choose a password"
                value={password}
                onChange={(v) => {
                  setPassword(v);
                  if (errors.password) setErrors((prev) => ({ ...prev, password: undefined }));
                }}
                error={errors.password}
                strength
                disabled={busy}
              />

              <Button type="submit" size="lg" className="mt-1 w-full" loading={busy} disabled={tooShort} leadingIcon={<UserCheck aria-hidden="true" />}>
                {busy ? "Joining…" : `Join ${studioName}`}
              </Button>
            </form>
          </CardContent>
        </Card>

        {alternative}

        <p className="text-center text-sm text-ink-muted">
          Already joined?{" "}
          <Link href="/login?from=invite" className="font-medium text-accent-ink underline-offset-4 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
