"use client";

import * as React from "react";
import { useMutationRunner, firstFieldErrors } from "@/components/jobs/mutation";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import type { NotificationType } from "@/lib/constants";

/** Display name of the portal account (PATCH /api/portal/me). */
export function PortalNameForm({ name, email, version }: { name: string; email: string; version: number }) {
  const run = useMutationRunner();
  const [value, setValue] = React.useState(name);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const changed = value.trim() !== name && value.trim().length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!changed) return;
    setPending(true);
    const res = await run(() => api.patch("/api/portal/me", { name: value.trim(), expectedVersion: version }), { success: "Name saved" });
    setPending(false);
    setError(res.ok ? null : (firstFieldErrors(res.fieldErrors).name ?? null));
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormField label="Your name" error={error}>
        <Input value={value} onChange={(e) => setValue(e.target.value)} maxLength={120} autoComplete="name" />
      </FormField>
      <FormField label="Email" description="Ask your studio if this needs to change.">
        <Input value={email} readOnly disabled />
      </FormField>
      <div>
        <Button type="submit" loading={pending} disabled={!changed}>
          Save name
        </Button>
      </div>
    </form>
  );
}

export interface PortalPref {
  type: NotificationType;
  label: string;
  enabled: boolean;
}

const DESCRIPTIONS: Partial<Record<NotificationType, string>> = {
  client_work_shared: "When your studio shares a job or a whole property with you.",
  client_work_delivered: "When finished work is ready to view.",
  client_feedback_reply: "When the studio replies to your feedback.",
};

/** In-app notification toggles for the three client types (PUT /api/portal/notification-prefs). */
export function PortalNotificationPrefs({ prefs }: { prefs: PortalPref[] }) {
  const run = useMutationRunner();
  const [pending, setPending] = React.useState<NotificationType | null>(null);

  async function toggle(type: NotificationType, next: boolean) {
    setPending(type);
    await run(() => api.put("/api/portal/notification-prefs", { prefs: { [type]: next } }), { success: next ? "Notifications on" : "Notifications off" });
    setPending(null);
  }

  return (
    <ul className="flex flex-col divide-y divide-border">
      {prefs.map((p) => (
        <li key={p.type} className="py-3 first:pt-0 last:pb-0">
          <Switch
            checked={p.enabled}
            disabled={pending === p.type}
            onCheckedChange={(v) => void toggle(p.type, v)}
            label={p.label}
            description={DESCRIPTIONS[p.type]}
            labelPosition="start"
            wrapperClassName="flex w-full"
          />
        </li>
      ))}
    </ul>
  );
}
