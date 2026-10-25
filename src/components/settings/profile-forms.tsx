"use client";

import * as React from "react";
import { UserRound } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { firstFieldErrors, useMutationRunner } from "@/components/jobs/mutation";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { displayRoleLabel } from "@/lib/constants";
import type { UserProfile } from "@/lib/types";
import { ColourField } from "./colour-field";
import { useConflict } from "./use-conflict";

/** Your own name and avatar colour (title only with Advanced tools on). Self edits only. */
export function ProfileForm({ profile, timeZone, showTitle = false, demo = false }: { profile: UserProfile; timeZone: string; showTitle?: boolean; demo?: boolean }) {
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
        <p className="text-xs text-ink-muted">
          {demo ? (
            // DEMO-07: nothing about signing in can change in the demo studio — no links to cards that aren't there.
            "Your email and password can’t be changed in the demo studio."
          ) : (
            <>
              Change your{" "}
              <a href="#email" className="font-medium text-accent-ink underline-offset-4 hover:underline">
                email
              </a>{" "}
              or{" "}
              <a href="#password" className="font-medium text-accent-ink underline-offset-4 hover:underline">
                password
              </a>{" "}
              further down.
            </>
          )}
          {profile.isAdmin ? null : " What you can do in the studio is set by the studio owner."}
        </p>
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
