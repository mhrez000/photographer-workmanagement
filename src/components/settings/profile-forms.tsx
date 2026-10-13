"use client";

import * as React from "react";
import { Eye, EyeOff, KeyRound, LogOut, UserRound } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { firstFieldErrors, useMutationRunner } from "@/components/jobs/mutation";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { displayRoleLabel } from "@/lib/constants";
import type { UserProfile } from "@/lib/types";
import { ColourField } from "./colour-field";
import { useConflict } from "./use-conflict";

const MIN_PASSWORD = 10;

/** Your own name and avatar colour (title only with Advanced tools on). Self edits only. */
export function ProfileForm({ profile, timeZone, showTitle = false }: { profile: UserProfile; timeZone: string; showTitle?: boolean }) {
  const run = useMutationRunner();
  const { onConflict, dialog } = useConflict("profile", timeZone);
  const [name, setName] = React.useState(profile.name);
  const [title, setTitle] = React.useState(profile.title ?? "");
  const [colour, setColour] = React.useState(profile.avatarColour);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState(false);
  const [version, setVersion] = React.useState(profile.version);

  if (profile.version !== version) {
    setVersion(profile.version);
    setName(profile.name);
    setTitle(profile.title ?? "");
    setColour(profile.avatarColour);
  }

  const dirty = name.trim() !== profile.name || (showTitle && (title.trim() || null) !== profile.title) || colour !== profile.avatarColour;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    setErrors({});
    setPending(true);
    const body: Record<string, unknown> = { expectedVersion: profile.version };
    if (name.trim() !== profile.name) body.name = name.trim();
    if (showTitle && (title.trim() || null) !== profile.title) body.title = title.trim() || null;
    if (colour !== profile.avatarColour) body.avatarColour = colour;
    const res = await run(() => api.patch(`/api/users/${profile.id}`, body), { success: "Profile saved", onConflict });
    setPending(false);
    if (!res.ok && res.fieldErrors) setErrors(firstFieldErrors(res.fieldErrors));
  };

  return (
    <SectionCard id="profile" title="Profile" description="How you appear on jobs, messages and in History." actions={<UserRound aria-hidden="true" className="size-4 text-ink-subtle" />}>
      <form onSubmit={save} noValidate className="flex flex-col gap-5">
        <div className="flex items-center gap-4">
          <Avatar name={name || profile.name} colour={colour} size="xl" />
          <div className="min-w-0">
            <p className="truncate text-md font-semibold text-ink">{name || profile.name}</p>
            <p className="truncate text-sm text-ink-muted">
              {displayRoleLabel({ role: profile.role, isAdmin: profile.isAdmin })} · {profile.email}
            </p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Full name" required error={errors.name} className={showTitle ? undefined : "sm:col-span-2"}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="name" />
          </FormField>
          {showTitle ? (
            <FormField label="Title" optional error={errors.title}>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Lead photographer" />
            </FormField>
          ) : null}
        </div>
        <FormField label="Avatar colour">
          <ColourField value={colour} onChange={setColour} label="Avatar colour" />
        </FormField>
        <p className="text-xs text-ink-muted">Your email and what you can do are set by the studio owner.</p>
        <div className="flex justify-end">
          <Button type="submit" loading={pending} disabled={!dirty}>
            Save profile
          </Button>
        </div>
      </form>
      {dialog}
    </SectionCard>
  );
}

function PasswordInput({
  value,
  onChange,
  autoComplete,
  ...field
}: {
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}) {
  const [visible, setVisible] = React.useState(false);
  return (
    <div className="relative">
      <Input
        {...field}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        invalid={field["aria-invalid"]}
        className="pr-10"
      />
      <IconButton label={visible ? "Hide password" : "Show password"} size="sm" onClick={() => setVisible((v) => !v)} className="absolute right-1 top-1/2 -translate-y-1/2">
        {visible ? <EyeOff /> : <Eye />}
      </IconButton>
    </div>
  );
}

/** Change your own password (POST /api/auth/change-password). */
export function ChangePasswordForm() {
  const run = useMutationRunner();
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState(false);

  const strength = next.length === 0 ? null : next.length < MIN_PASSWORD ? "short" : next.length < 14 ? "ok" : "strong";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const local: Record<string, string> = {};
    if (!current) local.current = "Enter your current password";
    if (next.length < MIN_PASSWORD) local.next = `Use at least ${MIN_PASSWORD} characters`;
    else if (next === current) local.next = "Choose a password different from the current one";
    if (confirm !== next) local.confirm = "Passwords don't match";
    setErrors(local);
    if (Object.keys(local).length > 0) return;
    setPending(true);
    const res = await run(() => api.post("/api/auth/change-password", { current, next }), {
      success: "Password changed",
      successDescription: "You're still signed in here; every other device was signed out.",
    });
    setPending(false);
    if (res.ok) {
      setCurrent("");
      setNext("");
      setConfirm("");
    } else if (res.fieldErrors) setErrors(firstFieldErrors(res.fieldErrors));
  };

  return (
    <SectionCard id="password" title="Password" description="At least 10 characters. A long phrase beats clever symbols." actions={<KeyRound aria-hidden="true" className="size-4 text-ink-subtle" />}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {/* Helps password managers associate the change with this account. */}
        <input type="text" autoComplete="username" hidden readOnly value="" />
        <FormField label="Current password" error={errors.current}>
          {(field) => <PasswordInput {...field} value={current} onChange={setCurrent} autoComplete="current-password" />}
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="New password"
            error={errors.next}
            description={
              strength === "short"
                ? `${MIN_PASSWORD - next.length} more characters`
                : strength === "ok"
                  ? "Good — longer is even better"
                  : strength === "strong"
                    ? "Strong"
                    : undefined
            }
          >
            {(field) => <PasswordInput {...field} value={next} onChange={setNext} autoComplete="new-password" />}
          </FormField>
          <FormField label="Confirm new password" error={errors.confirm}>
            {(field) => <PasswordInput {...field} value={confirm} onChange={setConfirm} autoComplete="new-password" />}
          </FormField>
        </div>
        <div className="flex flex-col gap-3 rounded-md bg-surface-sunken px-3 py-2.5 text-sm text-ink-secondary sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-start gap-2">
            <LogOut aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-muted" />
            Changing it signs you out on every other device and browser.
          </span>
          <Button type="submit" loading={pending} className="shrink-0">
            Change password
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}
