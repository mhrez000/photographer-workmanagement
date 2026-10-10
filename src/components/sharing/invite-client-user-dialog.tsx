"use client";

import * as React from "react";
import { UserPlus } from "lucide-react";
import { CopyButton } from "@/components/common/copy-button";
import { firstFieldErrors, useMutationRunner } from "@/components/jobs/mutation";
import { TempPasswordPanel } from "@/components/settings/temp-password-panel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { clientInviteMessage } from "@/lib/sharing";

interface InviteResponse {
  user: { id: string; name: string; email: string };
  tempPassword: string;
}

export interface InviteClientUserDialogProps {
  clientId: string;
  clientName: string;
  studioName: string;
  disabled?: boolean;
}

/**
 * "Invite client user" (docs/ROLES.md §6.1, §7.1): name + email → a portal
 * account for this client; the temporary password is shown once, with
 * "Copy invite message". No email is sent (§7.6).
 */
export function InviteClientUserDialog({ clientId, clientName, studioName, disabled = false }: InviteClientUserDialogProps) {
  const run = useMutationRunner();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<InviteResponse | null>(null);

  function reset(next: boolean) {
    setOpen(next);
    if (!next) {
      setName("");
      setEmail("");
      setErrors({});
      setResult(null);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    const res = await run(() => api.post<InviteResponse>("/api/users", { role: "client", clientId, name: name.trim(), email: email.trim() }), {
      success: `${name.trim() || "Client user"} can now sign in to the portal`,
    });
    setPending(false);
    if (res.ok) {
      setResult(res.data);
      setErrors({});
    } else setErrors(firstFieldErrors(res.fieldErrors));
  }

  return (
    <>
      <Button type="button" size="sm" leadingIcon={<UserPlus aria-hidden="true" />} disabled={disabled} onClick={() => setOpen(true)}>
        Invite client user
      </Button>
      <Dialog open={open} onOpenChange={(v) => (pending ? undefined : reset(v))}>
        <DialogHeader>
          <DialogTitle>{result ? "Portal account created" : `Invite someone from ${clientName}`}</DialogTitle>
          <DialogDescription>
            {result
              ? "Share the sign-in details privately. They'll choose a new password when they sign in."
              : "They'll see only the work you share with this client — never internal notes, editors or other clients."}
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <>
            <DialogBody className="flex flex-col gap-4">
              <TempPasswordPanel name={result.user.name} email={result.user.email} password={result.tempPassword} />
              <CopyButton
                value={clientInviteMessage({
                  studio: studioName,
                  // `result` exists only after a client-side submit, so window is defined here.
                  origin: typeof window === "undefined" ? "" : window.location.origin,
                  email: result.user.email,
                  password: result.tempPassword,
                })}
                label="Copy invite message"
                successMessage="Invite message copied"
                variant="outline"
              />
            </DialogBody>
            <DialogFooter>
              <Button onClick={() => reset(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit}>
            <DialogBody className="flex flex-col gap-4">
              <FormField label="Name" required error={errors.name}>
                <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={120} autoFocus />
              </FormField>
              <FormField label="Email" required error={errors.email} description="They sign in with this address.">
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" maxLength={254} />
              </FormField>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => reset(false)} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" loading={pending} disabled={!name.trim() || !email.trim()}>
                Create portal account
              </Button>
            </DialogFooter>
          </form>
        )}
      </Dialog>
    </>
  );
}
