"use client";

import * as React from "react";
import { useMutationRunner, firstFieldErrors } from "@/components/jobs";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ApiError } from "@/lib/api-client";
import { SIMPLE_REOPEN_REASON_LABELS, SIMPLE_REOPEN_REASONS, type SimpleReopenReason } from "@/lib/constants";
import { isAllowedLinkUrl } from "@/lib/validation/links";
import { cn } from "@/lib/utils";
import { simpleJobApi } from "./api";

export interface ReopenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  version: number;
  editorName?: string | null;
  jobLabel?: string;
  onConflict?: (error: ApiError) => void;
  onDone?: () => void;
}

const HELP: Record<SimpleReopenReason, string> = {
  client_changes: "Goes back to the editor as Changes asked, with your note.",
  fix_delivery_link: "Stays Done. The new link replaces the one the client has.",
};

/** The one Reopen on a Done job: two reasons (plan §5 ⋯ menu). */
export function ReopenDialog(props: ReopenDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange} size="sm">
      {props.open ? <ReopenForm {...props} /> : null}
    </Dialog>
  );
}

function ReopenForm({ onOpenChange, jobId, version, editorName, jobLabel, onConflict, onDone }: ReopenDialogProps) {
  const run = useMutationRunner();
  const [reason, setReason] = React.useState<SimpleReopenReason>("client_changes");
  const [note, setNote] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const local: Record<string, string> = {};
    if (reason === "client_changes" && !note.trim()) local.note = "Say what the client wants changed.";
    if (reason === "fix_delivery_link" && !isAllowedLinkUrl(url.trim())) local.newLink = "Paste the new delivery link (https://…).";
    setErrors(local);
    if (Object.keys(local).length > 0) return;
    setBusy(true);
    const result = await run(
      () =>
        simpleJobApi.reopen(jobId, {
          expectedVersion: version,
          reason,
          ...(reason === "client_changes" ? { note: note.trim() } : { newLink: { url: url.trim() } }),
        }),
      {
        success: reason === "client_changes" ? "Reopened · Changes asked" : "Delivery link replaced",
        onConflict: (err) => {
          onOpenChange(false);
          onConflict?.(err);
        },
      },
    );
    setBusy(false);
    if (result.ok) {
      onOpenChange(false);
      onDone?.();
    } else if (result.fieldErrors) {
      const f = firstFieldErrors(result.fieldErrors);
      setErrors({ note: f.note ?? "", newLink: f.newLink ?? f["newLink.url"] ?? "", form: f.reason ?? "" });
    }
  };

  return (
    <form onSubmit={submit} noValidate className="contents">
      <DialogHeader>
        <DialogTitle>Reopen this job</DialogTitle>
        <DialogDescription>{jobLabel ? <span className="font-medium text-ink-secondary">{jobLabel}. </span> : null}Why does it need reopening?</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4 pb-5">
        <div role="radiogroup" aria-label="Reason" className="flex flex-col gap-2">
          {SIMPLE_REOPEN_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={reason === r}
              onClick={() => setReason(r)}
              className={cn(
                "flex w-full flex-col items-start gap-0.5 rounded-md border px-3 py-2.5 text-left transition-colors focus-ring",
                reason === r ? "border-accent bg-accent-soft/60" : "border-border hover:bg-surface-muted",
              )}
            >
              <span className="text-sm font-medium text-ink">{SIMPLE_REOPEN_REASON_LABELS[r]}</span>
              <span className="text-xs text-ink-muted">{HELP[r]}</span>
            </button>
          ))}
        </div>
        {reason === "client_changes" ? (
          <FormField label="What does the client want changed?" required error={errors.note || undefined}>
            <Textarea
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                if (errors.note) setErrors((p) => ({ ...p, note: "" }));
              }}
              rows={3}
              maxLength={5000}
              placeholder={editorName ? `${editorName} will read this.` : "The editor will read this."}
            />
          </FormField>
        ) : (
          <FormField label="New delivery link" required error={errors.newLink || undefined}>
            <Input
              type="url"
              inputMode="url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (errors.newLink) setErrors((p) => ({ ...p, newLink: "" }));
              }}
              placeholder="https://"
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>
        )}
        {errors.form ? (
          <p role="alert" className="text-sm text-danger">
            {errors.form}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" loading={busy}>
          {reason === "client_changes" ? "Reopen & ask for changes" : "Replace the link"}
        </Button>
      </DialogFooter>
    </form>
  );
}
