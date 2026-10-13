"use client";

import * as React from "react";
import Link from "next/link";
import { Camera, Store, UserPlus, Wand2 } from "lucide-react";
import { CopyButton } from "@/components/common/copy-button";
import { firstFieldErrors, useMutationRunner } from "@/components/jobs/mutation";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api-client";
import { PHOTOGRAPHER_PRESETS, PHOTOGRAPHER_PRESET_META, type PhotographerPreset, type Role } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { inviteMessage } from "./permission-copy";
import { TempPasswordPanel } from "./temp-password-panel";

/** A client whose portal is on (only those can get portal users). */
export interface PortalClientOption {
  id: string;
  name: string;
}

export interface InvitePersonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** For the "Copy invite message" text. */
  studioName: string;
  /** Non-archived clients with the portal on. */
  portalClients: PortalClientOption[];
  initialRole?: Role;
  initialClientId?: string | null;
}

/** The three roles (docs/SIMPLIFICATION-PLAN.md §2), in plain words. */
export const ROLE_CARDS: { role: Role; title: string; body: string; icon: React.ComponentType<{ className?: string; "aria-hidden"?: "true" }> }[] = [
  { role: "photographer", title: "Photographer", body: "Shoots, creates jobs, gives them to editors and checks the edits.", icon: Camera },
  { role: "editor", title: "Editor", body: "Edits the jobs given to them, sends them for checking, fixes changes.", icon: Wand2 },
  { role: "client", title: "Client", body: "Sees progress and the finished photos in a simple portal.", icon: Store },
];

interface InviteResult {
  user: { id: string; name: string; email: string };
  tempPassword: string;
}

/**
 * Invite someone (plan §2): pick a role, type a name and email. A photographer gets ONE choice,
 * "Only their own shoots" or "Everything (co-owner)"; an editor an optional "Can add their own jobs"
 * tick; a client picks the client they work for. The result is a one-time temporary password.
 */
export function InvitePersonDialog({ open, onOpenChange, studioName, portalClients, initialRole = "photographer", initialClientId = null }: InvitePersonDialogProps) {
  const run = useMutationRunner();
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState<Role>(initialRole);
  const [preset, setPreset] = React.useState<PhotographerPreset>("own_shoots");
  const [editorCreates, setEditorCreates] = React.useState(false);
  const [clientId, setClientId] = React.useState<string>(initialClientId ?? portalClients[0]?.id ?? "");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<InviteResult | null>(null);
  // Read once on the client (the result panel only renders after a client-side invite).
  const [origin] = React.useState(() => (typeof window === "undefined" ? "" : window.location.origin));

  const reset = () => {
    setEmail("");
    setName("");
    setRole(initialRole);
    setPreset("own_shoots");
    setEditorCreates(false);
    setClientId(initialClientId ?? portalClients[0]?.id ?? "");
    setErrors({});
    setResult(null);
  };

  const close = (next: boolean) => {
    if (pending) return;
    onOpenChange(next);
    if (!next) reset();
  };

  const body = (): Record<string, unknown> => {
    const base = { email: email.trim(), name: name.trim() };
    if (role === "client") return { ...base, role, clientId };
    if (role === "editor") return { ...base, role, flags: { canCreateJobs: editorCreates } };
    return { ...base, role, preset };
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    if (role === "client" && !clientId) {
      setErrors({ clientId: "Choose the client this person works for" });
      return;
    }
    setPending(true);
    const res = await run(() => api.post<InviteResult>("/api/users", body()), { success: `${name.trim() || "Someone"} was invited` });
    setPending(false);
    if (res.ok) setResult(res.data);
    else if (res.fieldErrors) setErrors(firstFieldErrors(res.fieldErrors));
  };

  const message = result ? inviteMessage({ studio: studioName, origin, email: result.user.email, password: result.tempPassword }) : "";

  return (
    <Dialog open={open} onOpenChange={close} size="lg">
      {result ? (
        <>
          <DialogHeader>
            <DialogTitle>{result.user.name} can sign in now</DialogTitle>
            <DialogDescription>Copy the temporary password or the whole message before you close this. It is shown once.</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4 pb-4">
            <TempPasswordPanel name={result.user.name} email={result.user.email} password={result.tempPassword} />
            <div className="rounded-lg border border-border bg-surface p-3.5">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-ink">Message to send them</p>
                <CopyButton value={message} label="Copy message" successMessage="Message copied" variant="outline" />
              </div>
              <p className="mt-2 text-sm text-ink-muted" data-invite-message="">
                {message}
              </p>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setResult(null)}>
              Invite another
            </Button>
            <Button onClick={() => close(false)}>Done</Button>
          </DialogFooter>
        </>
      ) : (
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>Invite someone</DialogTitle>
            <DialogDescription>They get a temporary password that you pass on. Nothing is emailed.</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-5 pb-4">
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-ink">Who are they?</legend>
              <div role="radiogroup" aria-label="Role" className="grid gap-2 sm:grid-cols-3">
                {ROLE_CARDS.map((card) => {
                  const Icon = card.icon;
                  const selected = role === card.role;
                  return (
                    <button
                      key={card.role}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-role-card={card.role}
                      onClick={() => {
                        setRole(card.role);
                        setErrors({});
                      }}
                      className={cn(
                        "flex flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors duration-(--motion-fast) focus-ring",
                        selected ? "border-accent bg-accent-soft/50" : "border-border bg-surface hover:border-border-hover",
                      )}
                    >
                      <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                        <Icon aria-hidden="true" className={cn("size-4", selected ? "text-accent-ink" : "text-ink-subtle")} />
                        {card.title}
                      </span>
                      <span className="text-xs text-ink-muted">{card.body}</span>
                    </button>
                  );
                })}
              </div>
              {errors.role ? <p className="mt-1.5 text-sm text-danger">{errors.role}</p> : null}
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Full name" required error={errors.name}>
                <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="off" maxLength={120} />
              </FormField>
              <FormField label="Email" required error={errors.email}>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
              </FormField>
            </div>

            {role === "photographer" ? (
              <fieldset>
                <legend className="mb-2 text-sm font-medium text-ink">What can they see?</legend>
                <div role="radiogroup" aria-label="Photographer access" className="grid gap-2 sm:grid-cols-2">
                  {PHOTOGRAPHER_PRESETS.map((key) => {
                    const def = PHOTOGRAPHER_PRESET_META[key];
                    const selected = preset === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        data-preset={key}
                        onClick={() => setPreset(key)}
                        className={cn(
                          "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors duration-(--motion-fast) focus-ring",
                          selected ? "border-accent bg-accent-soft/50" : "border-border bg-surface hover:border-border-hover",
                        )}
                      >
                        <span className="text-sm font-semibold text-ink">{def.label}</span>
                        <span className="text-xs text-ink-muted">{def.description}</span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ) : role === "editor" ? (
              <Checkbox
                checked={editorCreates}
                onChange={(e) => setEditorCreates(e.target.checked)}
                label="Can add their own jobs"
                description="Off by default. When on, they can create a job for a photographer and start editing it themselves."
              />
            ) : (
              <FormField
                label="Client"
                required
                error={errors.clientId}
                description={
                  <>
                    Only clients with the portal on are listed.{" "}
                    <Link href="/clients" className="text-accent-ink hover:underline">
                      Turn the portal on from the client&apos;s page
                    </Link>
                    .
                  </>
                }
              >
                <Select value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Choose a client" disabled={portalClients.length === 0}>
                  {portalClients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </FormField>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => close(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" loading={pending} disabled={role === "client" && portalClients.length === 0} leadingIcon={<UserPlus aria-hidden="true" />}>
              Invite
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}
