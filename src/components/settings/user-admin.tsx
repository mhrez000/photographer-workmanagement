"use client";

import * as React from "react";
import { Crown, IdCard, Lock } from "lucide-react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { SectionCard } from "@/components/common/section-card";
import { firstFieldErrors, useMutationRunner } from "@/components/jobs/mutation";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api-client";
import type { UserProfile } from "@/lib/types";
import { ColourField } from "./colour-field";
import { useConflict } from "./use-conflict";

/**
 * What the viewer may change on this person (computed server-side with `can()`,
 * docs/ROLES.md §3.3–§3.4 — including the primary-owner protection).
 */
export interface UserAdminAccess {
  edit: boolean;
  changeEmail: boolean;
  changeRole: boolean;
  grantAdmin: boolean;
  revokeAdmin: boolean;
  setPermissions: boolean;
  setCapacity: boolean;
  /** Shown when the controls are locked (e.g. "Only Hannah Brooks can change their own account"). */
  lockedReason?: string | null;
}

export interface UserAdminProps {
  profile: UserProfile;
  access: UserAdminAccess;
  isPrimaryOwner: boolean;
  defaultCapacity: number;
  timeZone: string;
  /** Client users: their client's name and portal state. */
  client?: { id: string; name: string; portalEnabled: boolean; archived: boolean } | null;
  /** Job title is an Advanced-only field (SIMPLIFICATION-PLAN §8). */
  showTitle?: boolean;
}

function LockedNote({ reason }: { reason?: string | null }) {
  if (!reason) return null;
  return (
    <p className="flex items-start gap-2 rounded-md bg-surface-muted px-3 py-2 text-sm text-ink-muted">
      <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      {reason}
    </p>
  );
}

/* ------------------------------------------------------------------ */
/*  Profile                                                            */
/* ------------------------------------------------------------------ */

/** Name, sign-in email and avatar colour (title only with Advanced tools on). PATCH /api/users/:id. */
export function UserProfileCard({ profile, access, timeZone, showTitle = false }: UserAdminProps) {
  const run = useMutationRunner();
  const { onConflict, dialog } = useConflict("person", timeZone);
  const [name, setName] = React.useState(profile.name);
  const [title, setTitle] = React.useState(profile.title ?? "");
  const [email, setEmail] = React.useState(profile.email);
  const [colour, setColour] = React.useState(profile.avatarColour);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState(false);
  const [version, setVersion] = React.useState(profile.version);

  if (profile.version !== version) {
    setVersion(profile.version);
    setName(profile.name);
    setTitle(profile.title ?? "");
    setEmail(profile.email);
    setColour(profile.avatarColour);
  }

  const isClient = profile.role === "client";
  const titleEditable = showTitle && !isClient;
  const disabled = !access.edit || Boolean(profile.anonymisedAt);
  const emailDisabled = !access.changeEmail || Boolean(profile.anonymisedAt);
  const dirty =
    name.trim() !== profile.name || (titleEditable && (title.trim() || null) !== profile.title) || email.trim().toLowerCase() !== profile.email || colour !== profile.avatarColour;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    setErrors({});
    setPending(true);
    const body: Record<string, unknown> = { expectedVersion: profile.version };
    if (name.trim() !== profile.name) body.name = name.trim();
    if (titleEditable && (title.trim() || null) !== profile.title) body.title = title.trim() || null;
    if (email.trim().toLowerCase() !== profile.email) body.email = email.trim();
    if (colour !== profile.avatarColour) body.avatarColour = colour;
    const res = await run(() => api.patch(`/api/users/${profile.id}`, body), { success: "Saved", onConflict });
    setPending(false);
    if (!res.ok && res.fieldErrors) setErrors(firstFieldErrors(res.fieldErrors));
  };

  return (
    <SectionCard title="Details" description="Their name, the email they sign in with and their avatar colour." actions={<IdCard aria-hidden="true" className="size-4 text-ink-subtle" />}>
      <form onSubmit={save} className="flex flex-col gap-4" noValidate>
        <LockedNote reason={disabled ? access.lockedReason : null} />
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Full name" error={errors.name} className={titleEditable ? undefined : "sm:col-span-2"}>
            <Input value={name} onChange={(e) => setName(e.target.value)} disabled={disabled} maxLength={120} />
          </FormField>
          {titleEditable ? (
            <FormField label="Title" optional error={errors.title} description="Shown after their role, e.g. “Senior editor”.">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={disabled} maxLength={120} />
            </FormField>
          ) : null}
          <FormField label="Email" description="Used to sign in." error={errors.email} className="sm:col-span-2">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={emailDisabled} />
          </FormField>
        </div>
        <FormField label="Avatar colour">
          <ColourField value={colour} onChange={setColour} disabled={disabled} label="Avatar colour" />
        </FormField>
        {!disabled || !emailDisabled ? (
          <div className="flex justify-end">
            <Button type="submit" size="sm" loading={pending} disabled={!dirty}>
              Save
            </Button>
          </div>
        ) : null}
      </form>
      {dialog}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Primary owner                                                      */
/* ------------------------------------------------------------------ */

export interface TransferPrimaryOwnerCardProps {
  /** Other active co-owners who can become the owner. */
  candidates: { id: string; name: string }[];
  /** organisation_settings version (optimistic lock). */
  settingsVersion: number;
}

/** Shown on the owner's own page: hand the studio to another co-owner. */
export function TransferPrimaryOwnerCard({ candidates, settingsVersion }: TransferPrimaryOwnerCardProps) {
  const run = useMutationRunner();
  const [target, setTarget] = React.useState(candidates[0]?.id ?? "");
  const [open, setOpen] = React.useState(false);
  const targetName = candidates.find((c) => c.id === target)?.name ?? "";

  return (
    <SectionCard
      title="Transfer ownership"
      description="You are the owner: nobody else can change or deactivate your account. You can hand this to a co-owner; you stay a co-owner."
      actions={<Crown aria-hidden="true" className="size-4 text-ink-subtle" />}
    >
      {candidates.length === 0 ? (
        <p className="text-sm text-ink-muted">Give another photographer “Everything (co-owner)” first. Only a co-owner can become the owner.</p>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <FormField label="Transfer to" className="flex-1">
            <Select value={target} onChange={(e) => setTarget(e.target.value)}>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FormField>
          <Button variant="outline" onClick={() => setOpen(true)} disabled={!target}>
            Transfer ownership…
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Make ${targetName} the owner?`}
        description="They get the protections you have now. You stay a co-owner, but they could then remove your access."
        confirmLabel="Transfer"
        destructive
        onConfirm={async () => {
          const res = await run(() => api.post("/api/organisation/primary-owner", { userId: target, expectedVersion: settingsVersion }), {
            success: `${targetName} is now the owner`,
          });
          return res.ok || res.handled;
        }}
      />
    </SectionCard>
  );
}
