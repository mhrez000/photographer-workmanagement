"use client";

import * as React from "react";
import { Crown, Gauge, IdCard, Lock, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { SectionCard } from "@/components/common/section-card";
import { firstFieldErrors, useMutationRunner } from "@/components/jobs/mutation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import { PERSONA_LABELS, STAFF_ROLES, personaLabel, type EditorFlag, type MemberFlag, type StaffRole } from "@/lib/constants";
import type { UserProfile } from "@/lib/types";
import { ColourField } from "./colour-field";
import { editorAccessSummary, editorFlagsOf, memberAccessSummary, memberFlagsOf } from "./permission-copy";
import { PermissionSwitches } from "./permission-switches";
import { useConflict } from "./use-conflict";

/**
 * What the viewer may change on this person (computed server-side with `can()`,
 * docs/ROLES.md §3.3–§3.4 — including the primary-owner protection).
 */
export interface UserAdminAccess {
  edit: boolean;
  changeEmail: boolean;
  changeRole: boolean;
  /** Grant admin (target is an active photographer, not self). */
  grantAdmin: boolean;
  /** Revoke admin (not self, not the primary owner). */
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

export function UserProfileCard({ profile, access, timeZone }: UserAdminProps) {
  const run = useMutationRunner();
  const { onConflict, dialog } = useConflict("user", timeZone);
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
  const disabled = !access.edit || Boolean(profile.anonymisedAt);
  const emailDisabled = !access.changeEmail || Boolean(profile.anonymisedAt);
  const dirty =
    name.trim() !== profile.name ||
    (!isClient && (title.trim() || null) !== profile.title) ||
    email.trim().toLowerCase() !== profile.email ||
    colour !== profile.avatarColour;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    setErrors({});
    setPending(true);
    const body: Record<string, unknown> = { expectedVersion: profile.version };
    if (name.trim() !== profile.name) body.name = name.trim();
    if (!isClient && (title.trim() || null) !== profile.title) body.title = title.trim() || null;
    if (email.trim().toLowerCase() !== profile.email) body.email = email.trim();
    if (colour !== profile.avatarColour) body.avatarColour = colour;
    const res = await run(() => api.patch(`/api/users/${profile.id}`, body), { success: "Profile updated", onConflict });
    setPending(false);
    if (!res.ok && res.fieldErrors) setErrors(firstFieldErrors(res.fieldErrors));
  };

  return (
    <SectionCard title="Profile" description="Name, title, sign-in email and avatar colour." actions={<IdCard aria-hidden="true" className="size-4 text-ink-subtle" />}>
      <form onSubmit={save} className="flex flex-col gap-4" noValidate>
        <LockedNote reason={disabled ? access.lockedReason : null} />
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Full name" error={errors.name}>
            <Input value={name} onChange={(e) => setName(e.target.value)} disabled={disabled} maxLength={120} />
          </FormField>
          {!isClient ? (
            <FormField label="Title" optional error={errors.title} description="Shown after their role, e.g. “Photographer (team member) · Senior photographer”.">
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
              Save profile
            </Button>
          </div>
        ) : null}
      </form>
      {dialog}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Access: role, admin, permission switches, capacity                 */
/* ------------------------------------------------------------------ */

const ROLE_OPTION_LABEL: Record<StaffRole, string> = { photographer: "Photographer", editor: "Editor" };

export function UserAccessCard({ profile, access, isPrimaryOwner, defaultCapacity, timeZone, client }: UserAdminProps) {
  const run = useMutationRunner();
  const { onConflict, dialog } = useConflict("user", timeZone);
  const isStaff = profile.role === "photographer" || profile.role === "editor";
  const [role, setRole] = React.useState<StaffRole>(profile.role === "editor" ? "editor" : "photographer");
  const [capacity, setCapacity] = React.useState(profile.capacityHoursPerWeek === null ? "" : String(profile.capacityHoursPerWeek));
  const [capError, setCapError] = React.useState<string | undefined>();
  const [pending, setPending] = React.useState<string | null>(null);
  const [adminConfirm, setAdminConfirm] = React.useState<null | boolean>(null);
  const [version, setVersion] = React.useState(profile.version);

  if (profile.version !== version) {
    setVersion(profile.version);
    setRole(profile.role === "editor" ? "editor" : "photographer");
    setCapacity(profile.capacityHoursPerWeek === null ? "" : String(profile.capacityHoursPerWeek));
  }

  const anonymised = Boolean(profile.anonymisedAt);
  const targetIsAdmin = profile.role === "photographer" && profile.isAdmin;

  if (profile.role === "client") {
    return (
      <SectionCard title="Client portal access" description="Client users only see work shared with their client." actions={<ShieldCheck aria-hidden="true" className="size-4 text-ink-subtle" />}>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-ink-muted">Client</dt>
            <dd className="mt-0.5 font-medium text-ink">
              {client ? (
                <a href={`/clients/${client.id}`} className="text-accent-ink hover:underline">
                  {client.name}
                </a>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">Portal</dt>
            <dd className="mt-0.5">
              {client?.archived ? (
                <Badge variant="neutral" size="sm">
                  Client archived — cannot sign in
                </Badge>
              ) : client?.portalEnabled ? (
                <Badge variant="success" size="sm" dot>
                  On
                </Badge>
              ) : (
                <Badge variant="warning" size="sm" dot>
                  Off — cannot sign in
                </Badge>
              )}
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-sm text-ink-muted">A client user always stays with this client. To give someone access to another client, invite a new account.</p>
      </SectionCard>
    );
  }

  const saveRole = async () => {
    if (role === profile.role) return;
    setPending("role");
    const res = await run(() => api.post(`/api/users/${profile.id}/role`, { role, expectedVersion: profile.version }), {
      success: `${profile.name} is now ${role === "editor" ? "an editor" : "a photographer (team member)"}`,
      successDescription: "Their permission switches were reset to the defaults. They'll be asked to sign in again.",
      onConflict,
    });
    setPending(null);
    if (!res.ok) setRole(profile.role === "editor" ? "editor" : "photographer");
  };

  const saveAdmin = async (isAdmin: boolean) => {
    setPending("admin");
    const res = await run(() => api.post(`/api/users/${profile.id}/admin`, { isAdmin, expectedVersion: profile.version }), {
      success: isAdmin ? `${profile.name} is now an admin` : `${profile.name} is now a team member`,
      successDescription: isAdmin ? "They have every permission." : "Their saved team-member switches apply again.",
      onConflict,
    });
    setPending(null);
    return res.ok || res.handled;
  };

  const setFlag = async (flag: MemberFlag | EditorFlag, value: boolean) => {
    setPending(flag);
    await run(() => api.post(`/api/users/${profile.id}/permissions`, { [flag]: value, expectedVersion: profile.version }), {
      success: value ? "Permission turned on" : "Permission turned off",
      onConflict,
    });
    setPending(null);
  };

  const saveCapacity = async () => {
    setCapError(undefined);
    const value = capacity.trim() === "" ? null : Number(capacity);
    if (value !== null && (Number.isNaN(value) || value < 0 || value > 168)) {
      setCapError("Enter hours between 0 and 168, or leave blank for the default");
      return;
    }
    setPending("capacity");
    const res = await run(() => api.post(`/api/users/${profile.id}/capacity`, { capacityHoursPerWeek: value, expectedVersion: profile.version }), {
      success: "Capacity updated",
      onConflict,
    });
    setPending(null);
    if (!res.ok && res.fieldErrors) setCapError(firstFieldErrors(res.fieldErrors).capacityHoursPerWeek);
  };

  const capacityDirty = (capacity.trim() === "" ? null : Number(capacity)) !== profile.capacityHoursPerWeek;
  const roleLocked = !access.changeRole || anonymised || !isStaff;
  const adminLocked = anonymised || (targetIsAdmin ? !access.revokeAdmin : !access.grantAdmin);
  const flagsLocked = !access.setPermissions || anonymised || targetIsAdmin;
  const memberFlags = memberFlagsOf(profile);
  const editorFlags = editorFlagsOf(profile);

  return (
    <SectionCard
      title="Access"
      description="Role, admin, what they can do, and weekly capacity for workload bands."
      actions={<ShieldCheck aria-hidden="true" className="size-4 text-ink-subtle" />}
    >
      <div className="flex flex-col divide-y divide-border">
        {access.lockedReason && roleLocked && adminLocked ? (
          <div className="pb-5">
            <LockedNote reason={access.lockedReason} />
          </div>
        ) : null}

        <div className="flex flex-col gap-3 py-5 first:pt-0 sm:flex-row sm:items-end">
          <FormField
            label="Role"
            className="flex-1"
            description={
              targetIsAdmin
                ? "Admins are photographers. Remove admin first to make them an editor."
                : "Photographer ⇄ editor. Changing a role resets their permission switches and signs them out everywhere."
            }
          >
            <Select value={role} onChange={(e) => setRole(e.target.value as StaffRole)} disabled={roleLocked || targetIsAdmin}>
              {STAFF_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_OPTION_LABEL[r]}
                </option>
              ))}
            </Select>
          </FormField>
          {!roleLocked && !targetIsAdmin ? (
            <Button variant="outline" onClick={saveRole} loading={pending === "role"} disabled={role === profile.role} className="sm:mb-[22px]">
              Change role
            </Button>
          ) : null}
        </div>

        {profile.role === "photographer" ? (
          <div className="flex flex-col gap-2 py-5">
            <Switch
              checked={targetIsAdmin}
              onCheckedChange={(v) => setAdminConfirm(v)}
              disabled={adminLocked || pending !== null}
              label={
                <span className="inline-flex items-center gap-2">
                  Admin (co-owner)
                  {isPrimaryOwner ? (
                    <Badge variant="accent" size="sm">
                      <Crown aria-hidden="true" /> Primary owner
                    </Badge>
                  ) : null}
                </span>
              }
              description={
                isPrimaryOwner
                  ? "The primary owner is always an admin. Transfer primary ownership first."
                  : "Admins see and change every job, person and setting — shown as “Owner / Photographer”."
              }
              labelPosition="start"
              wrapperClassName="w-full"
            />
          </div>
        ) : null}

        {isStaff ? (
          <div className="flex flex-col gap-4 py-5">
            <div className="flex items-center gap-2">
              <SlidersHorizontal aria-hidden="true" className="size-4 text-ink-subtle" />
              <h3 className="text-sm font-semibold text-ink">What they can do</h3>
            </div>
            {targetIsAdmin ? (
              <p className="text-sm text-ink-muted">Admins have every permission. Their team-member switches are kept and apply again if admin is removed.</p>
            ) : profile.role === "photographer" ? (
              <>
                <PermissionSwitches
                  kind="member"
                  aria-label={`${PERSONA_LABELS.member} permissions`}
                  values={memberFlags}
                  onToggle={flagsLocked ? undefined : (flag, value) => void setFlag(flag, value)}
                  disabled={flagsLocked}
                  pendingFlag={pending && pending in memberFlags ? (pending as MemberFlag) : null}
                />
                <p className="rounded-md bg-surface-muted px-3 py-2 text-sm text-ink-secondary">{memberAccessSummary(memberFlags)}</p>
              </>
            ) : (
              <>
                <PermissionSwitches
                  kind="editor"
                  aria-label="Editor permissions"
                  values={editorFlags}
                  onToggle={flagsLocked ? undefined : (flag, value) => void setFlag(flag, value)}
                  disabled={flagsLocked}
                  pendingFlag={pending && pending in editorFlags ? (pending as EditorFlag) : null}
                />
                <p className="rounded-md bg-surface-muted px-3 py-2 text-sm text-ink-secondary">{editorAccessSummary(editorFlags)}</p>
              </>
            )}
          </div>
        ) : null}

        <div className="flex flex-col gap-3 pt-5 sm:flex-row sm:items-start">
          <FormField
            label={
              <span className="inline-flex items-center gap-1.5">
                <Gauge aria-hidden="true" className="size-3.5 text-ink-subtle" /> Weekly capacity
              </span>
            }
            className="flex-1"
            description={`Blank = studio default (${defaultCapacity} h). Workload bands compare estimated work to this.`}
            error={capError}
          >
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              max={168}
              step="0.5"
              value={capacity}
              placeholder={String(defaultCapacity)}
              onChange={(e) => setCapacity(e.target.value)}
              disabled={!access.setCapacity || anonymised}
              trailing={<span className="text-xs">h/wk</span>}
              className="numeric"
            />
          </FormField>
          {access.setCapacity && !anonymised ? (
            <Button variant="outline" onClick={saveCapacity} loading={pending === "capacity"} disabled={!capacityDirty} className="sm:mt-[26px]">
              Save capacity
            </Button>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={adminConfirm !== null}
        onOpenChange={(o) => {
          if (!o) setAdminConfirm(null);
        }}
        title={adminConfirm ? `Make ${profile.name} an admin?` : `Remove admin from ${profile.name}?`}
        description={
          adminConfirm
            ? "Admins can change every setting, every job and every person except the primary owner. They'll show as “Owner / Photographer”."
            : `They become a ${personaLabel({ role: "photographer", isAdmin: false }).toLowerCase()} again with the switches they had before.`
        }
        confirmLabel={adminConfirm ? "Make admin" : "Remove admin"}
        destructive={adminConfirm === false}
        onConfirm={() => saveAdmin(adminConfirm === true)}
      />
      {dialog}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Primary owner                                                      */
/* ------------------------------------------------------------------ */

export interface TransferPrimaryOwnerCardProps {
  /** Other active admins who can become the primary owner. */
  candidates: { id: string; name: string }[];
  /** organisation_settings version (optimistic lock). */
  settingsVersion: number;
}

/** Shown on the primary owner's own page (docs/ROLES.md §3.4, §11). */
export function TransferPrimaryOwnerCard({ candidates, settingsVersion }: TransferPrimaryOwnerCardProps) {
  const run = useMutationRunner();
  const [target, setTarget] = React.useState(candidates[0]?.id ?? "");
  const [open, setOpen] = React.useState(false);
  const targetName = candidates.find((c) => c.id === target)?.name ?? "";

  return (
    <SectionCard
      title="Primary owner"
      description="You are the primary owner: other admins can't demote, deactivate or change your account. You can hand this to another admin; you stay an admin."
      actions={<Crown aria-hidden="true" className="size-4 text-ink-subtle" />}
    >
      {candidates.length === 0 ? (
        <p className="text-sm text-ink-muted">Make another photographer an admin first — only an admin can become the primary owner.</p>
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
            Transfer primary ownership…
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Make ${targetName} the primary owner?`}
        description="They get the protections you have now. You stay an admin, but they could then remove your admin access."
        confirmLabel="Transfer"
        destructive
        onConfirm={async () => {
          const res = await run(() => api.post("/api/organisation/primary-owner", { userId: target, expectedVersion: settingsVersion }), {
            success: `${targetName} is now the primary owner`,
          });
          return res.ok || res.handled;
        }}
      />
    </SectionCard>
  );
}
