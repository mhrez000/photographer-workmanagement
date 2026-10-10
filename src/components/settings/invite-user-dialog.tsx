"use client";

import * as React from "react";
import Link from "next/link";
import { Camera, ShieldAlert, Store, UserPlus, Wand2 } from "lucide-react";
import { CopyButton } from "@/components/common/copy-button";
import { firstFieldErrors, useMutationRunner } from "@/components/jobs/mutation";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api-client";
import {
  AVATAR_PALETTE,
  EDITOR_INVITE_DEFAULTS,
  MEMBER_INVITE_DEFAULTS,
  type EditorFlag,
  type MemberFlag,
  type Role,
} from "@/lib/constants";
import { cn } from "@/lib/utils";
import { ColourField } from "./colour-field";
import { editorAccessSummary, inviteMessage, memberAccessSummary, type EditorFlagValues, type MemberFlagValues } from "./permission-copy";
import { PermissionSwitches } from "./permission-switches";
import { TempPasswordPanel } from "./temp-password-panel";

/** A client whose portal is on (only those can get portal users, docs/ROLES.md §6.1). */
export interface PortalClientOption {
  id: string;
  name: string;
}

export interface InviteUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultCapacity: number;
  /** For the "Copy invite message" text. */
  studioName: string;
  /** Non-archived clients with the portal on. */
  portalClients: PortalClientOption[];
  /** Preselect a role / client (e.g. "Invite client user" from a client page). */
  initialRole?: Role;
  initialClientId?: string | null;
}

/** The three role cards (docs/ROLES.md §11). */
const ROLE_CARDS: { role: Role; title: string; body: string; icon: React.ComponentType<{ className?: string; "aria-hidden"?: "true" }> }[] = [
  { role: "photographer", title: "Photographer", body: "Shoots and works on their own jobs. You choose what else they can do.", icon: Camera },
  { role: "editor", title: "Editor", body: "Edits the jobs assigned to them and can create jobs for a photographer.", icon: Wand2 },
  { role: "client", title: "Client", body: "Sees only the work you share with them, in a simple portal.", icon: Store },
];

interface InviteResult {
  user: { id: string; name: string; email: string };
  tempPassword: string;
}

/** Invite form → one-time temporary password reveal + "Copy invite message". */
export function InviteUserDialog({ open, onOpenChange, defaultCapacity, studioName, portalClients, initialRole = "photographer", initialClientId = null }: InviteUserDialogProps) {
  const run = useMutationRunner();
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState<Role>(initialRole);
  const [title, setTitle] = React.useState("");
  const [capacity, setCapacity] = React.useState("");
  const [colour, setColour] = React.useState<string>(AVATAR_PALETTE[0]);
  const [makeAdmin, setMakeAdmin] = React.useState(false);
  const [memberFlags, setMemberFlags] = React.useState<MemberFlagValues>({ ...MEMBER_INVITE_DEFAULTS });
  const [editorFlags, setEditorFlags] = React.useState<EditorFlagValues>({ ...EDITOR_INVITE_DEFAULTS });
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
    setTitle("");
    setCapacity("");
    setMakeAdmin(false);
    setMemberFlags({ ...MEMBER_INVITE_DEFAULTS });
    setEditorFlags({ ...EDITOR_INVITE_DEFAULTS });
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
    const base = { email: email.trim(), name: name.trim(), avatarColour: colour };
    const cap = capacity.trim() === "" ? undefined : Number(capacity);
    if (role === "client") return { ...base, role, clientId };
    if (role === "editor") return { ...base, role, title: title.trim() || null, capacityHoursPerWeek: cap, flags: editorFlags };
    return { ...base, role, title: title.trim() || null, capacityHoursPerWeek: cap, ...(makeAdmin ? { isAdmin: true } : { flags: memberFlags }) };
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    if (role === "client" && !clientId) {
      setErrors({ clientId: "Choose the client this person works for" });
      return;
    }
    setPending(true);
    const res = await run(() => api.post<InviteResult>("/api/users", body()), { success: `${name.trim() || "User"} invited` });
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
            <DialogDescription>Copy the temporary password or the whole invite message before closing this window.</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4 pb-4">
            <TempPasswordPanel name={result.user.name} email={result.user.email} password={result.tempPassword} />
            <div className="rounded-lg border border-border bg-surface p-3.5">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-ink">Invite message</p>
                <CopyButton value={message} label="Copy invite message" successMessage="Invite message copied" variant="outline" />
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
            <DialogDescription>They get a temporary password you share with them. Nothing is emailed.</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-5 pb-4">
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-ink">Role</legend>
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

            {role === "client" ? (
              <FormField
                label="Client"
                required
                error={errors.clientId}
                description={
                  portalClients.length === 0 ? (
                    <>
                      No client has the portal on yet.{" "}
                      <Link href="/clients" className="text-accent-ink hover:underline">
                        Turn on the portal on the client&apos;s page
                      </Link>
                      .
                    </>
                  ) : (
                    <>
                      Only clients with the portal on are listed.{" "}
                      <Link href="/clients" className="text-accent-ink hover:underline">
                        Turn on the portal on the client&apos;s page
                      </Link>
                      .
                    </>
                  )
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
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Title" optional error={errors.title}>
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={role === "editor" ? "Senior editor" : "Senior photographer"} maxLength={120} />
                </FormField>
                <FormField label="Capacity" optional description={`Blank = studio default (${defaultCapacity} h/wk).`} error={errors.capacityHoursPerWeek}>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={168}
                    step="0.5"
                    value={capacity}
                    onChange={(e) => setCapacity(e.target.value)}
                    trailing={<span className="text-xs">h/wk</span>}
                    className="numeric"
                  />
                </FormField>
              </div>
            )}

            <FormField label="Avatar colour">
              <ColourField value={colour} onChange={setColour} label="Avatar colour" />
            </FormField>

            {role === "photographer" ? (
              <fieldset className="flex flex-col gap-4 rounded-lg border border-border p-3.5">
                <legend className="px-1 text-sm font-medium text-ink">What they can do</legend>
                <div className="flex flex-col gap-2">
                  <Checkbox
                    checked={makeAdmin}
                    onChange={(e) => setMakeAdmin(e.target.checked)}
                    label="Make admin (co-owner)"
                    description="Admins run the business with you."
                  />
                  {makeAdmin ? (
                    <p role="status" className="flex items-start gap-2 rounded-md border border-warning/25 bg-warning-soft/50 px-3 py-2 text-sm text-warning-fg">
                      <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                      Admins can change every setting, every job and every person except the primary owner.
                    </p>
                  ) : null}
                </div>
                {!makeAdmin ? (
                  <PermissionSwitches
                    kind="member"
                    aria-label="Team-member permissions"
                    values={memberFlags}
                    onToggle={(flag: MemberFlag, value) => setMemberFlags((f) => ({ ...f, [flag]: value }))}
                  />
                ) : null}
                <p className="rounded-md bg-surface-muted px-3 py-2 text-sm text-ink-secondary" aria-live="polite" data-access-summary="">
                  {memberAccessSummary(memberFlags, { isAdmin: makeAdmin })}
                </p>
              </fieldset>
            ) : role === "editor" ? (
              <fieldset className="flex flex-col gap-4 rounded-lg border border-border p-3.5">
                <legend className="px-1 text-sm font-medium text-ink">What they can do</legend>
                <PermissionSwitches
                  kind="editor"
                  aria-label="Editor permissions"
                  values={editorFlags}
                  onToggle={(flag: EditorFlag, value) => setEditorFlags((f) => ({ ...f, [flag]: value }))}
                />
                <p className="rounded-md bg-surface-muted px-3 py-2 text-sm text-ink-secondary" aria-live="polite" data-access-summary="">
                  {editorAccessSummary(editorFlags)}
                </p>
              </fieldset>
            ) : (
              <p className="rounded-md bg-surface-muted px-3 py-2 text-sm text-ink-secondary">
                They sign in at the same login page and land in the client portal. They see only jobs and projects you share with their client.
              </p>
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
