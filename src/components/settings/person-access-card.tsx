"use client";

import * as React from "react";
import { Crown, Lock, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { SectionCard } from "@/components/common/section-card";
import { firstFieldErrors, useMutationRunner } from "@/components/jobs/mutation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import {
  PHOTOGRAPHER_PRESETS,
  PHOTOGRAPHER_PRESET_META,
  photographerPresetOf,
  presetSwitches,
  type EditorFlag,
  type MemberFlag,
  type PhotographerPreset,
} from "@/lib/constants";
import type { UserProfile } from "@/lib/types";
import { cn } from "@/lib/utils";
import { editorFlagsOf, memberFlagsOf } from "./permission-copy";
import { PermissionSwitches } from "./permission-switches";
import { useConflict } from "./use-conflict";

export interface PersonAccess {
  /** Grant admin (target is an active photographer, not self). */
  grantAdmin: boolean;
  /** Revoke admin (not self, not the primary owner). */
  revokeAdmin: boolean;
  setPermissions: boolean;
  setCapacity: boolean;
  /** Why the controls are locked (primary owner, or "this is you"). */
  lockedReason?: string | null;
}

export interface PersonAccessCardProps {
  profile: UserProfile;
  access: PersonAccess;
  isPrimaryOwner: boolean;
  /** Settings → Studio → Advanced tools: shows the individual switches (plan §8). */
  advanced: boolean;
  timeZone: string;
}

interface SafeUserLite {
  version: number;
}

/**
 * What a person can see and do (docs/SIMPLIFICATION-PLAN.md §2). A photographer is ONE choice —
 * "Only their own shoots" or "Everything (co-owner)" — and shows "Custom" when their switches match
 * neither. An editor has "Can add their own jobs" and "Usually handles up to N". The six individual
 * switches only appear with Advanced tools on.
 */
export function PersonAccessCard({ profile, access, isPrimaryOwner, advanced, timeZone }: PersonAccessCardProps) {
  const run = useMutationRunner();
  const { onConflict, dialog } = useConflict("person", timeZone);
  const [pending, setPending] = React.useState<string | null>(null);
  const [confirmPreset, setConfirmPreset] = React.useState<PhotographerPreset | null>(null);
  const [capacity, setCapacity] = React.useState(profile.usualCapacityJobs === null ? "" : String(profile.usualCapacityJobs));
  const [capError, setCapError] = React.useState<string | undefined>();
  const [version, setVersion] = React.useState(profile.version);

  if (profile.version !== version) {
    setVersion(profile.version);
    setCapacity(profile.usualCapacityJobs === null ? "" : String(profile.usualCapacityJobs));
  }

  const anonymised = Boolean(profile.anonymisedAt);
  const isAdmin = profile.role === "photographer" && profile.isAdmin;
  const current = photographerPresetOf(profile);

  /* ---------------- photographer preset ---------------- */

  const applyPreset = async (next: PhotographerPreset): Promise<boolean> => {
    const target = presetSwitches(next);
    setPending("preset");
    let ok = true;
    let expectedVersion = profile.version;
    try {
      if (target.isAdmin !== isAdmin) {
        const res = await run(() => api.post<SafeUserLite>(`/api/users/${profile.id}/admin`, { isAdmin: target.isAdmin, expectedVersion }), { noRefresh: !target.isAdmin, onConflict });
        if (!res.ok) ok = false;
        else expectedVersion = res.data.version;
      }
      if (ok && !target.isAdmin) {
        const res = await run(() => api.post(`/api/users/${profile.id}/permissions`, { ...target.flags, expectedVersion }), { onConflict });
        if (!res.ok) ok = false;
      }
    } finally {
      setPending(null);
    }
    return ok;
  };

  const presetLocked = anonymised || !profile.isActive || (isAdmin ? !access.revokeAdmin : !access.grantAdmin && !access.setPermissions);

  /* ---------------- editor switches ---------------- */

  const setFlag = async (flag: MemberFlag | EditorFlag, value: boolean) => {
    setPending(flag);
    await run(() => api.post(`/api/users/${profile.id}/permissions`, { [flag]: value, expectedVersion: profile.version }), {
      success: value ? "Turned on" : "Turned off",
      onConflict,
    });
    setPending(null);
  };

  const saveCapacity = async () => {
    setCapError(undefined);
    const value = capacity.trim() === "" ? null : Number(capacity);
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 500)) {
      setCapError("Enter a whole number from 1 to 500, or leave it blank");
      return;
    }
    setPending("capacity");
    const res = await run(() => api.post(`/api/users/${profile.id}/usual-capacity`, { usualCapacityJobs: value, expectedVersion: profile.version }), {
      success: value === null ? "Cleared" : `Usually handles up to ${value}`,
      onConflict,
    });
    setPending(null);
    if (!res.ok && res.fieldErrors) setCapError(firstFieldErrors(res.fieldErrors).usualCapacityJobs);
  };
  const capacityDirty = (capacity.trim() === "" ? null : Number(capacity)) !== profile.usualCapacityJobs;

  if (profile.role === "client") return null;

  return (
    <SectionCard title="What they can do" description={profile.role === "photographer" ? "One choice. The owner can always step in on any job." : "Editors see only the jobs given to them."} actions={<ShieldCheck aria-hidden="true" className="size-4 text-ink-subtle" />}>
      <div className="flex flex-col gap-5">
        {access.lockedReason && presetLocked ? (
          <p className="flex items-start gap-2 rounded-md bg-surface-muted px-3 py-2 text-sm text-ink-muted">
            <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            {access.lockedReason}
          </p>
        ) : null}

        {profile.role === "photographer" ? (
          <div className="flex flex-col gap-3">
            <div role="radiogroup" aria-label="Photographer access" className="grid gap-2 sm:grid-cols-2">
              {PHOTOGRAPHER_PRESETS.map((key) => {
                const def = PHOTOGRAPHER_PRESET_META[key];
                const selected = current === key;
                return (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-preset={key}
                    disabled={presetLocked || pending !== null}
                    onClick={() => (selected ? undefined : setConfirmPreset(key))}
                    className={cn(
                      "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors duration-(--motion-fast) focus-ring disabled:cursor-default disabled:opacity-70",
                      selected ? "border-accent bg-accent-soft/50" : "border-border bg-surface hover:border-border-hover",
                    )}
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                      {def.label}
                      {key === "co_owner" && isPrimaryOwner ? (
                        <Badge variant="accent" size="sm">
                          <Crown aria-hidden="true" /> Owner
                        </Badge>
                      ) : null}
                    </span>
                    <span className="text-xs text-ink-muted">{def.description}</span>
                  </button>
                );
              })}
            </div>
            {current === "custom" ? (
              <p className="flex items-start gap-2 rounded-md border border-warning/25 bg-warning-soft/40 px-3 py-2 text-sm text-ink-secondary" data-preset-custom="">
                <SlidersHorizontal aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning-fg" />
                <span>
                  <span className="font-medium text-ink">Custom.</span> This person has a mix of switches from before. Pick a choice above to replace it
                  {advanced ? ", or adjust the switches below" : ""}.
                </span>
              </p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-border">
            <div className="flex items-start justify-between gap-6 pb-4">
              <div className="min-w-0">
                <p id="editor-creates-label" className="text-base font-medium text-ink">
                  Can add their own jobs
                </p>
                <p className="mt-0.5 text-sm text-ink-muted">Off by default. When on, they can create a job for a photographer and start editing it themselves.</p>
              </div>
              <Switch
                checked={profile.canCreateJobs}
                onCheckedChange={(v) => void setFlag("canCreateJobs", v)}
                disabled={!access.setPermissions || anonymised || pending !== null}
                aria-labelledby="editor-creates-label"
                aria-busy={pending === "canCreateJobs" || undefined}
              />
            </div>
            <div className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-start">
              <FormField
                label="Usually handles up to"
                className="flex-1"
                description="Optional. When set, their row on Editors reads “4 of 6” and turns amber when full. Blank = no limit shown."
                error={capError}
              >
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={500}
                  step="1"
                  value={capacity}
                  placeholder="—"
                  onChange={(e) => setCapacity(e.target.value)}
                  disabled={!access.setCapacity || anonymised}
                  trailing={<span className="text-xs">jobs</span>}
                  className="numeric"
                />
              </FormField>
              {access.setCapacity && !anonymised ? (
                <Button variant="outline" onClick={() => void saveCapacity()} loading={pending === "capacity"} disabled={!capacityDirty} className="sm:mt-[26px]">
                  Save
                </Button>
              ) : null}
            </div>
          </div>
        )}

        {advanced ? (
          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <div className="flex items-center gap-2">
              <SlidersHorizontal aria-hidden="true" className="size-4 text-ink-subtle" />
              <h3 className="text-sm font-semibold text-ink">Individual switches</h3>
              <Badge variant="outline" size="sm">
                Advanced
              </Badge>
            </div>
            {isAdmin ? (
              <p className="text-sm text-ink-muted">Co-owners have every switch on. Choose “Only their own shoots” to set switches one by one.</p>
            ) : profile.role === "photographer" ? (
              <PermissionSwitches
                kind="member"
                aria-label="Photographer switches"
                values={memberFlagsOf(profile)}
                onToggle={access.setPermissions && !anonymised ? (flag, value) => void setFlag(flag, value) : undefined}
                disabled={!access.setPermissions || anonymised}
                pendingFlag={pending && pending in memberFlagsOf(profile) ? (pending as MemberFlag) : null}
              />
            ) : (
              <PermissionSwitches
                kind="editor"
                aria-label="Editor switches"
                values={editorFlagsOf(profile)}
                onToggle={access.setPermissions && !anonymised ? (flag, value) => void setFlag(flag, value) : undefined}
                disabled={!access.setPermissions || anonymised}
                pendingFlag={pending && pending in editorFlagsOf(profile) ? (pending as EditorFlag) : null}
              />
            )}
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmPreset !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmPreset(null);
        }}
        title={confirmPreset === "co_owner" ? `Give ${profile.name} everything?` : `Limit ${profile.name} to their own shoots?`}
        description={
          confirmPreset === "co_owner"
            ? "They will see and do everything you can — every job, person and setting — except transfer ownership."
            : "They will see only the jobs they shot or created, and the clients on those jobs. They still give those jobs to editors and check the edits."
        }
        confirmLabel={confirmPreset === "co_owner" ? "Make co-owner" : "Only their own shoots"}
        destructive={confirmPreset === "own_shoots" && isAdmin}
        onConfirm={async () => {
          if (!confirmPreset) return true;
          return applyPreset(confirmPreset);
        }}
      />
      {dialog}
    </SectionCard>
  );
}
