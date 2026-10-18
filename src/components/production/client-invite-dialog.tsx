"use client";

import * as React from "react";
import { UserPlus } from "lucide-react";
import { CopyButton } from "@/components/common/copy-button";
import { firstFieldErrors, useMutationRunner } from "@/components/jobs/mutation";
import { InviteLinkPanel } from "@/components/settings/invite-link-panel";
import { inviteLinkMessage } from "@/components/settings/permission-copy";
import { TempPasswordPanel } from "@/components/settings/temp-password-panel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import type { InviteMethod } from "@/lib/constants";
import { clientInviteMessage } from "@/lib/sharing";

interface InvitedUser {
  id: string;
  name: string;
  email: string;
}

/** `POST /api/users { role: "client" }` — the shape depends on `method`. */
type InviteResult =
  | { method: "link"; user: InvitedUser; inviteUrl: string; emailed: boolean; expiresAt: string }
  | { method: "temp_password"; user: InvitedUser; tempPassword: string };

export interface ClientInviteDialogProps {
  clientId: string;
  clientName: string;
  studioName: string;
  timeZone: string;
  disabled?: boolean;
}

/**
 * The client page's "Invite someone" (docs/SIMPLIFICATION-PLAN.md §3 "Online access", front door):
 * name + email → a portal login for this client. By default they get a LINK to choose their own
 * password (emailed when the studio has email set up, otherwise shown here to copy); "Set a temporary
 * password instead" keeps the old one-time password. The portal must be on (the button is disabled
 * otherwise, and the server says so with a 422).
 */
export function ClientInviteDialog({ clientId, clientName, studioName, timeZone, disabled = false }: ClientInviteDialogProps) {
  const run = useMutationRunner();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [method, setMethod] = React.useState<InviteMethod>("link");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<InviteResult | null>(null);

  function reset(next: boolean) {
    setOpen(next);
    if (!next) {
      setName("");
      setEmail("");
      setMethod("link");
      setErrors({});
      setResult(null);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setPending(true);
    const res = await run(() => api.post<InviteResult>("/api/users", { role: "client", clientId, name: name.trim(), email: email.trim(), method }), {
      success: `${name.trim() || "Someone"} from ${clientName} was invited`,
      onError: (err) => {
        // 409 = the email is already in use somewhere (not an edit conflict): say so on the field.
        if (err.status === 409) {
          setErrors({ email: err.message || "That email is already in use." });
          return true;
        }
        if (err.status !== 429) return false;
        setErrors({ form: "That's a lot of invites in a short time. Wait a few minutes and try again." });
        return true;
      },
    });
    setPending(false);
    if (res.ok) setResult(res.data);
    else if (res.fieldErrors) setErrors((prev) => ({ ...prev, ...firstFieldErrors(res.fieldErrors) }));
  }

  const message = !result
    ? ""
    : result.method === "link"
      ? inviteLinkMessage({ studio: studioName, inviteUrl: result.inviteUrl, name: result.user.name })
      : clientInviteMessage({
          studio: studioName,
          // `result` exists only after a client-side submit, so window is defined here.
          origin: typeof window === "undefined" ? "" : window.location.origin,
          email: result.user.email,
          password: result.tempPassword,
        });

  return (
    <>
      <Button type="button" size="sm" leadingIcon={<UserPlus aria-hidden="true" />} disabled={disabled} onClick={() => setOpen(true)} data-invite-client-user="">
        Invite someone
      </Button>
      <Dialog open={open} onOpenChange={(v) => (pending ? undefined : reset(v))}>
        <DialogHeader>
          <DialogTitle>{result ? (result.method === "link" ? `Invite link for ${result.user.name}` : `${result.user.name} can sign in now`) : `Invite someone from ${clientName}`}</DialogTitle>
          <DialogDescription>
            {result
              ? result.method === "link"
                ? "They open the link, choose a password and see their work. Copy it before you close this."
                : "Share the sign-in details privately. They'll choose a new password when they sign in."
              : "They'll see only the work you share with this client — never internal notes, editors or other clients."}
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <>
            <DialogBody className="flex flex-col gap-4">
              {result.method === "link" ? (
                <InviteLinkPanel name={result.user.name} email={result.user.email} inviteUrl={result.inviteUrl} emailed={result.emailed} expiresAt={result.expiresAt} timeZone={timeZone} />
              ) : (
                <TempPasswordPanel name={result.user.name} email={result.user.email} password={result.tempPassword} />
              )}
              <div className="rounded-lg border border-border bg-surface p-3.5">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-ink">Message to send them</p>
                  <CopyButton value={message} label="Copy message" successMessage="Message copied" variant="outline" />
                </div>
                <p className="mt-2 break-words text-sm text-ink-muted" data-invite-message="">
                  {message}
                </p>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button onClick={() => reset(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} noValidate>
            <DialogBody className="flex flex-col gap-4">
              <FormField label="Name" required error={errors.name}>
                <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={120} autoFocus />
              </FormField>
              <FormField label="Email" required error={errors.email} description="They sign in with this address.">
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" maxLength={254} />
              </FormField>
              <div className="rounded-md bg-surface-sunken px-3 py-2.5 text-sm text-ink-muted" data-invite-method={method}>
                {method === "link" ? (
                  <>
                    They get a link to choose their own password.{" "}
                    <button type="button" className="font-medium text-accent-ink underline-offset-4 hover:underline focus-ring rounded-xs" onClick={() => setMethod("temp_password")}>
                      Set a temporary password instead
                    </button>
                  </>
                ) : (
                  <>
                    You get a temporary password to pass on; nothing is emailed.{" "}
                    <button type="button" className="font-medium text-accent-ink underline-offset-4 hover:underline focus-ring rounded-xs" onClick={() => setMethod("link")}>
                      Send an invite link instead
                    </button>
                  </>
                )}
              </div>
              {errors.form ? (
                <p role="alert" className="text-sm text-danger">
                  {errors.form}
                </p>
              ) : null}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => reset(false)} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" loading={pending} disabled={!name.trim() || !email.trim()}>
                Invite
              </Button>
            </DialogFooter>
          </form>
        )}
      </Dialog>
    </>
  );
}
