"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Mail, MailCheck, Send } from "lucide-react";
import { DevOnlyLink } from "@/components/auth/dev-only-link";
import { FormAlert } from "@/components/auth/form-alert";
import { useFocusFirstInvalid } from "@/components/auth/use-focus-first-invalid";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api-client";
import { accountErrorMessage, fieldErrorsOf } from "./account-errors";
import { AccountPasswordInput } from "./password-forms";

/** What POST /api/auth/email-change (and …/resend) answer (src/server/services/account.ts). */
type EmailChangeResponse =
  | { status: "pending"; newEmail: string; expiresAt: string; sent: boolean; reason: string | null; devLink?: string }
  | { status: "changed"; email: string };

export interface EmailChangePanelProps {
  /** The account's address now. */
  email: string;
  /** Changing the email needs the current password; Google-only accounts set one first. */
  hasPassword: boolean;
  /** Email is set up: the change waits for the link sent to the new address. Otherwise it applies at once. */
  emailConfigured: boolean;
  /** A change waiting for its link (`expiresLabel` already formatted in the studio's timezone). */
  pending: { newEmail: string; expiresLabel: string } | null;
}

/**
 * The interactive half of the Email card: the waiting change ("Waiting for you to confirm y · [Send again]
 * [Cancel change]"), and "Change email" → new address + current password (POST /api/auth/email-change).
 */
export function EmailChangePanel({ email, hasPassword, emailConfigured, pending }: EmailChangePanelProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [newEmail, setNewEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [busy, setBusy] = React.useState<"resend" | "cancel" | null>(null);
  const [devLink, setDevLink] = React.useState<string | null>(null);

  const close = () => {
    setOpen(false);
    setNewEmail("");
    setPassword("");
    setErrors({});
    setFormError(null);
  };

  /** Toasts (and the dev-only link) for a link that was — or wasn't — emailed to the new address. */
  const announcePending = (res: Extract<EmailChangeResponse, { status: "pending" }>) => {
    setDevLink(res.devLink ?? null);
    if (res.sent) toast.success("Check your new inbox", `We sent a link to ${res.newEmail}. Your email changes when you open it.`);
    else if (res.devLink) toast.info("Link ready", "Email isn’t sending from this computer, so the link is shown on the page.");
    else toast.warning("We couldn’t send the email", "Try “Send again” in a moment.");
  };

  const { ref: formRef, focusFirstInvalid } = useFocusFirstInvalid();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const local: Record<string, string> = {};
    if (!newEmail.trim()) local.newEmail = "Enter your new email address";
    if (!password) local.password = "Enter your current password";
    setErrors(local);
    setFormError(null);
    if (Object.keys(local).length > 0) {
      focusFirstInvalid();
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.post<EmailChangeResponse>("/api/auth/email-change", { newEmail: newEmail.trim(), password });
      close();
      if (res.status === "changed") {
        setDevLink(null);
        toast.success("Email changed", `Use ${res.email} to sign in from now on.`);
      } else {
        announcePending(res);
      }
      router.refresh();
    } catch (err) {
      const fields = fieldErrorsOf(err);
      if (Object.keys(fields).length > 0) setErrors(fields);
      else setFormError(accountErrorMessage(err));
      // UX-09: back to the first field with a problem (the fields were disabled while sending).
      focusFirstInvalid();
    } finally {
      setSubmitting(false);
    }
  };

  const resend = async () => {
    setBusy("resend");
    try {
      const res = await api.post<EmailChangeResponse>("/api/auth/email-change/resend");
      if (res.status === "pending") announcePending(res);
      router.refresh();
    } catch (err) {
      toast.error(accountErrorMessage(err));
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    setBusy("cancel");
    try {
      await api.post<{ cancelled: number }>("/api/auth/email-change/cancel");
      setDevLink(null);
      toast.success("Change cancelled", `Proofline keeps using ${email}.`);
      router.refresh();
    } catch (err) {
      toast.error(accountErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {pending ? (
        <div className="rounded-md border border-attention/30 bg-attention-soft/50 p-3" data-pending-email-change="" role="status">
          <div className="flex items-start gap-2">
            <MailCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-attention" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">
                Waiting for you to confirm <span className="break-all">{pending.newEmail}</span>
              </p>
              <p className="mt-0.5 text-sm text-ink-secondary">
                Open the link we sent to <span className="break-all">{pending.newEmail}</span> to finish. Until then Proofline keeps using{" "}
                <span className="break-all">{email}</span>. The link works until {pending.expiresLabel}.
              </p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 sm:pl-6">
            <Button size="sm" variant="outline" loading={busy === "resend"} disabled={busy !== null} onClick={resend} leadingIcon={<Send aria-hidden="true" />}>
              Send again
            </Button>
            <Button size="sm" variant="ghost" loading={busy === "cancel"} disabled={busy !== null} onClick={cancel}>
              Cancel change
            </Button>
          </div>
        </div>
      ) : null}

      {devLink ? <DevOnlyLink label="Confirm link" url={devLink} /> : null}

      {!hasPassword ? (
        <p className="text-sm text-ink-secondary" data-email-needs-password="">
          To change your email,{" "}
          <a href="#password" className="font-medium text-accent-ink underline-offset-4 hover:underline">
            set a password
          </a>{" "}
          first.
        </p>
      ) : open ? (
        <form ref={formRef} onSubmit={submit} noValidate className="flex flex-col gap-4" aria-busy={submitting || undefined} data-email-change-form="">
          {formError ? <FormAlert>{formError}</FormAlert> : null}
          <FormField label="New email" error={errors.newEmail || undefined}>
            {(field) => (
              <Input
                {...field}
                type="email"
                name="new-email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
                leading={<Mail aria-hidden="true" />}
                value={newEmail}
                onChange={(ev) => {
                  setNewEmail(ev.target.value);
                  if (errors.newEmail) setErrors((x) => ({ ...x, newEmail: "" }));
                }}
                invalid={Boolean(errors.newEmail)}
                disabled={submitting}
                maxLength={254}
              />
            )}
          </FormField>
          <FormField label="Current password" description="So we know it’s you." error={errors.password || undefined}>
            {(field) => (
              <AccountPasswordInput
                {...field}
                name="current-password"
                value={password}
                onChange={(v) => {
                  setPassword(v);
                  if (errors.password) setErrors((x) => ({ ...x, password: "" }));
                }}
                autoComplete="current-password"
                disabled={submitting}
              />
            )}
          </FormField>
          <p className="text-sm text-ink-muted">
            {emailConfigured
              ? "We’ll email a link to the new address. Your email changes when you open it, and we’ll let your current address know."
              : "Your email changes straight away. Use the new one the next time you sign in."}
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={close} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              {emailConfigured ? "Send confirmation link" : "Change email"}
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button variant="outline" onClick={() => setOpen(true)} leadingIcon={<Mail aria-hidden="true" />}>
            {pending ? "Use a different email" : "Change email"}
          </Button>
        </div>
      )}
    </div>
  );
}
