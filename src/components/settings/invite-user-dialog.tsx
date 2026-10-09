"use client";

import * as React from "react";
import { UserPlus } from "lucide-react";
import { firstFieldErrors, useMutationRunner } from "@/components/jobs/mutation";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api-client";
import { AVATAR_PALETTE, ROLES, ROLE_LABELS, type Role } from "@/lib/constants";
import { ColourField } from "./colour-field";
import { TempPasswordPanel } from "./temp-password-panel";

export interface InviteUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  viewerRole: Role;
  defaultCapacity: number;
}

const ROLE_HINT: Record<Role, string> = {
  owner: "Full access, including settings, workflows and billing-level decisions.",
  manager: "Runs production: every job, team, analytics, automations. Cannot change org settings or workflows.",
  photographer: "Creates jobs, reviews and approves their own work. Team visibility per settings.",
  editor: "Focused workspace: assigned jobs, timers, submissions and revisions.",
};

interface InviteResult {
  user: { id: string; name: string; email: string };
  tempPassword: string;
}

/** Invite form → one-time temporary password reveal. */
export function InviteUserDialog({ open, onOpenChange, viewerRole, defaultCapacity }: InviteUserDialogProps) {
  const run = useMutationRunner();
  const roles = viewerRole === "owner" ? ROLES : (["photographer", "editor"] as const);
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState<Role>("editor");
  const [title, setTitle] = React.useState("");
  const [capacity, setCapacity] = React.useState("");
  const [colour, setColour] = React.useState<string>(AVATAR_PALETTE[0]);
  const [teamWorkloads, setTeamWorkloads] = React.useState(false);
  const [analytics, setAnalytics] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<InviteResult | null>(null);

  const reset = () => {
    setEmail("");
    setName("");
    setRole("editor");
    setTitle("");
    setCapacity("");
    setTeamWorkloads(false);
    setAnalytics(false);
    setErrors({});
    setResult(null);
  };

  const close = (next: boolean) => {
    if (pending) return;
    onOpenChange(next);
    if (!next) reset();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    const cap = capacity.trim() === "" ? undefined : Number(capacity);
    setPending(true);
    const res = await run(
      () =>
        api.post<InviteResult>("/api/users", {
          email: email.trim(),
          name: name.trim(),
          role,
          title: title.trim() || null,
          avatarColour: colour,
          capacityHoursPerWeek: cap,
          canViewTeamWorkloads: role === "photographer" ? teamWorkloads : undefined,
          canViewAnalytics: role === "photographer" ? analytics : undefined,
        }),
      { success: `${name.trim() || "User"} invited` },
    );
    setPending(false);
    if (res.ok) setResult(res.data);
    else if (res.fieldErrors) setErrors(firstFieldErrors(res.fieldErrors));
  };

  return (
    <Dialog open={open} onOpenChange={close} size="md">
      {result ? (
        <>
          <DialogHeader>
            <DialogTitle>{result.user.name} can sign in now</DialogTitle>
            <DialogDescription>Copy the temporary password before closing this window.</DialogDescription>
          </DialogHeader>
          <DialogBody className="pb-4">
            <TempPasswordPanel name={result.user.name} email={result.user.email} password={result.tempPassword} />
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
            <DialogTitle>Invite a user</DialogTitle>
            <DialogDescription>They get a temporary password you share with them. Nothing is emailed.</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4 pb-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Full name" required error={errors.name}>
                <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="off" maxLength={120} />
              </FormField>
              <FormField label="Email" required error={errors.email}>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
              </FormField>
            </div>
            <FormField label="Role" description={ROLE_HINT[role]} error={errors.role}>
              <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </Select>
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Title" optional error={errors.title}>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Senior editor" maxLength={120} />
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
            <FormField label="Avatar colour">
              <ColourField value={colour} onChange={setColour} label="Avatar colour" />
            </FormField>
            {role === "photographer" ? (
              <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3.5">
                <legend className="px-1 text-sm font-medium text-ink">Extra visibility</legend>
                <Checkbox
                  checked={teamWorkloads}
                  onChange={(e) => setTeamWorkloads(e.target.checked)}
                  label="Can view team workloads"
                  description="Aggregate editor workloads (counts, bands) — never other people's job details."
                />
                <Checkbox
                  checked={analytics}
                  onChange={(e) => setAnalytics(e.target.checked)}
                  label="Can view analytics"
                  description="Insights: analytics, bottlenecks and reports, including CSV export."
                />
              </fieldset>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => close(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" loading={pending} leadingIcon={<UserPlus aria-hidden="true" />}>
              Invite
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}
