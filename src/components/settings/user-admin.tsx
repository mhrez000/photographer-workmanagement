"use client";

import * as React from "react";
import { Eye, Gauge, IdCard, ShieldCheck } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { firstFieldErrors, useMutationRunner } from "@/components/jobs/mutation";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import { ROLES, ROLE_LABELS, type Role } from "@/lib/constants";
import type { UserProfile } from "@/lib/types";
import { ColourField } from "./colour-field";
import { useConflict } from "./use-conflict";

export interface UserAdminProps {
  profile: UserProfile;
  viewerRole: Role;
  /** Viewer may administer this person (management, not self, scope ok). */
  canManage: boolean;
  defaultCapacity: number;
  timeZone: string;
}

/* ------------------------------------------------------------------ */
/*  Profile                                                            */
/* ------------------------------------------------------------------ */

export function UserProfileCard({ profile, canManage, timeZone }: UserAdminProps) {
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

  const dirty = name.trim() !== profile.name || (title.trim() || null) !== profile.title || email.trim().toLowerCase() !== profile.email || colour !== profile.avatarColour;
  const disabled = !canManage || Boolean(profile.anonymisedAt);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    setErrors({});
    setPending(true);
    const body: Record<string, unknown> = { expectedVersion: profile.version };
    if (name.trim() !== profile.name) body.name = name.trim();
    if ((title.trim() || null) !== profile.title) body.title = title.trim() || null;
    if (email.trim().toLowerCase() !== profile.email) body.email = email.trim();
    if (colour !== profile.avatarColour) body.avatarColour = colour;
    const res = await run(() => api.patch(`/api/users/${profile.id}`, body), { success: "Profile updated", onConflict });
    setPending(false);
    if (!res.ok && res.fieldErrors) setErrors(firstFieldErrors(res.fieldErrors));
  };

  return (
    <SectionCard title="Profile" description="Name, title, sign-in email and avatar colour." actions={<IdCard aria-hidden="true" className="size-4 text-ink-subtle" />}>
      <form onSubmit={save} className="flex flex-col gap-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Full name" error={errors.name}>
            <Input value={name} onChange={(e) => setName(e.target.value)} disabled={disabled} maxLength={120} />
          </FormField>
          <FormField label="Title" optional error={errors.title}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={disabled} maxLength={120} />
          </FormField>
          <FormField label="Email" description="Used to sign in." error={errors.email} className="sm:col-span-2">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={disabled} />
          </FormField>
        </div>
        <FormField label="Avatar colour">
          <ColourField value={colour} onChange={setColour} disabled={disabled} label="Avatar colour" />
        </FormField>
        {!disabled ? (
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
/*  Role, capacity, visibility                                         */
/* ------------------------------------------------------------------ */

export function UserAccessCard({ profile, viewerRole, canManage, defaultCapacity, timeZone }: UserAdminProps) {
  const run = useMutationRunner();
  const { onConflict, dialog } = useConflict("user", timeZone);
  const [role, setRole] = React.useState<Role>(profile.role);
  const [capacity, setCapacity] = React.useState(profile.capacityHoursPerWeek === null ? "" : String(profile.capacityHoursPerWeek));
  const [capError, setCapError] = React.useState<string | undefined>();
  const [pending, setPending] = React.useState<string | null>(null);
  const [version, setVersion] = React.useState(profile.version);

  if (profile.version !== version) {
    setVersion(profile.version);
    setRole(profile.role);
    setCapacity(profile.capacityHoursPerWeek === null ? "" : String(profile.capacityHoursPerWeek));
  }

  const locked = !canManage || Boolean(profile.anonymisedAt);
  // Managers may only move people between photographer and editor (ARCHITECTURE §3.2).
  const roleOptions: readonly Role[] = viewerRole === "owner" ? ROLES : (["photographer", "editor"] as const);

  const saveRole = async () => {
    if (role === profile.role) return;
    setPending("role");
    const res = await run(() => api.post(`/api/users/${profile.id}/role`, { role, expectedVersion: profile.version }), {
      success: `${profile.name} is now ${ROLE_LABELS[role].toLowerCase() === "owner" ? "an owner" : `a ${ROLE_LABELS[role].toLowerCase()}`}`,
      successDescription: "They'll be asked to sign in again.",
      onConflict,
    });
    setPending(null);
    if (!res.ok) setRole(profile.role);
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

  const setFlag = async (key: "canViewTeamWorkloads" | "canViewAnalytics", value: boolean) => {
    setPending(key);
    await run(() => api.post(`/api/users/${profile.id}/visibility`, { [key]: value, expectedVersion: profile.version }), {
      success: value ? "Access granted" : "Access removed",
      onConflict,
    });
    setPending(null);
  };

  const capacityDirty = (capacity.trim() === "" ? null : Number(capacity)) !== profile.capacityHoursPerWeek;

  return (
    <SectionCard title="Access & capacity" description="Role, weekly capacity for workload bands, and extra visibility." actions={<ShieldCheck aria-hidden="true" className="size-4 text-ink-subtle" />}>
      <div className="flex flex-col divide-y divide-border">
        <div className="flex flex-col gap-3 pb-5 sm:flex-row sm:items-end">
          <FormField
            label="Role"
            className="flex-1"
            description={
              viewerRole === "manager" && canManage ? "Managers can switch people between photographer and editor." : "Changing a role signs the person out everywhere."
            }
          >
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={locked}>
              {(roleOptions.includes(profile.role) ? roleOptions : [profile.role, ...roleOptions]).map((r) => (
                <option key={r} value={r} disabled={!roleOptions.includes(r)}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
          </FormField>
          {!locked ? (
            <Button variant="outline" onClick={saveRole} loading={pending === "role"} disabled={role === profile.role} className="sm:mb-[22px]">
              Change role
            </Button>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 py-5 sm:flex-row sm:items-start">
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
              disabled={locked}
              trailing={<span className="text-xs">h/wk</span>}
              className="numeric"
            />
          </FormField>
          {!locked ? (
            <Button variant="outline" onClick={saveCapacity} loading={pending === "capacity"} disabled={!capacityDirty} className="sm:mt-[26px]">
              Save capacity
            </Button>
          ) : null}
        </div>

        <div className="flex flex-col gap-4 pt-5">
          <div className="flex items-center gap-2">
            <Eye aria-hidden="true" className="size-4 text-ink-subtle" />
            <h3 className="text-sm font-semibold text-ink">Extra visibility</h3>
          </div>
          {profile.role === "photographer" ? (
            <>
              <Switch
                checked={profile.canViewTeamWorkloads}
                onCheckedChange={(v) => setFlag("canViewTeamWorkloads", v)}
                disabled={locked || pending !== null}
                label="Can view team workloads"
                description="Aggregate editor workloads only — counts and bands, never other people's job details."
                labelPosition="start"
                wrapperClassName="w-full"
              />
              <Switch
                checked={profile.canViewAnalytics}
                onCheckedChange={(v) => setFlag("canViewAnalytics", v)}
                disabled={locked || pending !== null}
                label="Can view analytics"
                description="Insights pages: analytics, bottlenecks, reports and CSV export."
                labelPosition="start"
                wrapperClassName="w-full"
              />
            </>
          ) : profile.role === "editor" ? (
            <p className="text-sm text-ink-muted">
              Editors’ team visibility is studio-wide: see <span className="font-medium text-ink-secondary">Organisation → Visibility</span>.
            </p>
          ) : (
            <p className="text-sm text-ink-muted">{ROLE_LABELS[profile.role]}s already see everything.</p>
          )}
        </div>
      </div>
      {dialog}
    </SectionCard>
  );
}
