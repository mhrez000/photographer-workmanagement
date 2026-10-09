"use client";

import * as React from "react";
import { ConflictDialog, firstFieldErrors, useMutationRunner } from "@/components/jobs";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { api, type ApiError } from "@/lib/api-client";

export interface CapacityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: { id: string; name: string };
  /** Current resolved capacity (hours / week). */
  capacityHours: number;
  /** The organisation default (used when "Use studio default" is ticked). */
  defaultHours: number;
  /** True when the person has no personal override. */
  usesDefault: boolean;
  /** users.version for optimistic concurrency. */
  version: number;
  timeZone?: string;
}

/** Edits an editor's weekly capacity (POST /api/users/:id/capacity with expectedVersion). */
export function CapacityDialog({ open, onOpenChange, ...rest }: CapacityDialogProps) {
  const [conflict, setConflict] = React.useState<ApiError | null>(null);
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange} size="sm">
        {open ? <CapacityForm {...rest} onClose={() => onOpenChange(false)} onConflict={setConflict} /> : null}
      </Dialog>
      <ConflictDialog open={conflict !== null} onOpenChange={(o) => !o && setConflict(null)} error={conflict} entity="person" timeZone={rest.timeZone} />
    </>
  );
}

function CapacityForm({
  user,
  capacityHours,
  defaultHours,
  usesDefault,
  version,
  onClose,
  onConflict,
}: Omit<CapacityDialogProps, "open" | "onOpenChange"> & { onClose: () => void; onConflict: (e: ApiError) => void }) {
  const run = useMutationRunner();
  const [useDefault, setUseDefault] = React.useState(usesDefault);
  const [value, setValue] = React.useState(String(capacityHours));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const hours = Number(value);
    if (!useDefault && (!Number.isFinite(hours) || hours <= 0 || hours > 80)) {
      setErrors({ capacityHoursPerWeek: "Enter between 1 and 80 hours a week." });
      return;
    }
    setSaving(true);
    const result = await run(
      () => api.post(`/api/users/${user.id}/capacity`, { capacityHoursPerWeek: useDefault ? null : hours, expectedVersion: version }),
      {
        success: `Capacity updated for ${user.name}`,
        onConflict: (err) => {
          onClose();
          onConflict(err);
        },
      },
    );
    setSaving(false);
    if (result.ok) onClose();
    else if (result.fieldErrors) setErrors(firstFieldErrors(result.fieldErrors));
  };

  return (
    <form onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle>Weekly capacity</DialogTitle>
        <DialogDescription>
          How many weighted editing hours {user.name.split(" ")[0]} can take on per week. Workload bands compare their current load against this.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        <Checkbox
          checked={useDefault}
          onChange={(e) => setUseDefault(e.currentTarget.checked)}
          label={`Use the studio default (${defaultHours}h / week)`}
        />
        <FormField label="Hours per week" error={errors.capacityHoursPerWeek ?? errors.expectedVersion} hint="Typical full-time editor: 30–38h">
          <Input
            type="number"
            inputMode="decimal"
            min={1}
            max={80}
            step={0.5}
            value={useDefault ? String(defaultHours) : value}
            disabled={useDefault}
            onChange={(e) => setValue(e.currentTarget.value)}
            trailing={<span className="text-xs text-ink-muted">h</span>}
            className="numeric"
          />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" loading={saving}>
          Save capacity
        </Button>
      </DialogFooter>
    </form>
  );
}
