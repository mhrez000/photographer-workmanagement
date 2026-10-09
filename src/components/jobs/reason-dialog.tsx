"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { firstFieldErrors, type DialogSubmitResult } from "./mutation";

export interface ReasonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  label?: string;
  placeholder?: string;
  /** Reason must be non-empty (cancel, reopen, override). Default true. */
  required?: boolean;
  confirmLabel?: string;
  destructive?: boolean;
  /** One-tap reason chips that fill the field. */
  suggestions?: readonly string[];
  /** Extra content above the field (e.g. a status picker). */
  children?: React.ReactNode;
  /** Disable confirm until the parent is ready (e.g. nothing picked yet). */
  confirmDisabled?: boolean;
  onSubmit: (reason: string) => Promise<DialogSubmitResult> | DialogSubmitResult;
}

/** Asks for a reason before an audited action (cancel, reopen, decline, override…). */
export function ReasonDialog(props: ReasonDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange} size="sm">
      {props.open ? <ReasonForm {...props} /> : null}
    </Dialog>
  );
}

function ReasonForm({
  onOpenChange,
  title,
  description,
  label = "Reason",
  placeholder = "Add context for the history log…",
  required = true,
  confirmLabel = "Confirm",
  destructive = false,
  suggestions,
  children,
  confirmDisabled = false,
  onSubmit,
}: ReasonDialogProps) {
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = reason.trim();
    if (required && !trimmed) {
      setError("A reason is required — it is kept in the job history.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await onSubmit(trimmed);
      if (result === true) onOpenChange(false);
      else if (typeof result === "object") {
        const errors = firstFieldErrors(result.fieldErrors);
        setError(errors.reason ?? Object.values(errors)[0] ?? "Please check the form.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="contents">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
      </DialogHeader>
      <DialogBody className="space-y-4 pb-5">
        {children}
        {suggestions && suggestions.length > 0 ? (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Suggested reasons">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setReason(s)}
                className={cn(
                  "h-7 rounded-full border px-2.5 text-xs transition-colors focus-ring",
                  reason === s ? "border-accent bg-accent-soft text-accent-ink" : "border-border bg-surface text-ink-secondary hover:bg-surface-muted",
                )}
              >
                {s}
              </button>
            ))}
          </div>
        ) : null}
        <FormField label={label} required={required} optional={!required} error={error ?? undefined}>
          <Textarea
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              if (error) setError(null);
            }}
            placeholder={placeholder}
            rows={3}
            maxLength={2000}
            autoFocus
          />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant={destructive ? "danger" : "primary"} loading={submitting} disabled={confirmDisabled}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
