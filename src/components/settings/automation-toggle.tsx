"use client";

import * as React from "react";
import { useMutationRunner } from "@/components/jobs/mutation";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import { useConflict } from "./use-conflict";

/** Enable / disable a rule in place (POST /api/automations/:id/toggle). */
export function AutomationToggle({ id, name, enabled, version, disabled }: { id: string; name: string; enabled: boolean; version: number; disabled?: boolean }) {
  const run = useMutationRunner();
  const { onConflict, dialog } = useConflict("rule");
  const [optimistic, setOptimistic] = React.useState<boolean | null>(null);
  const [pending, setPending] = React.useState(false);
  const checked = optimistic ?? enabled;

  const toggle = async (next: boolean) => {
    setOptimistic(next);
    setPending(true);
    await run(() => api.post(`/api/automations/${id}/toggle`, { expectedVersion: version, isEnabled: next }), {
      success: next ? `“${name}” enabled` : `“${name}” paused`,
      onConflict,
    });
    setPending(false);
    setOptimistic(null);
  };

  return (
    <>
      <Switch checked={checked} onCheckedChange={toggle} disabled={disabled || pending} aria-label={`${checked ? "Disable" : "Enable"} ${name}`} />
      {dialog}
    </>
  );
}
