"use client";

import * as React from "react";
import { ArchiveRestore, Play } from "lucide-react";
import { ConfirmDialog } from "@/components/common";
import { ReasonDialog, useMutationRunner, toDialogResult } from "@/components/jobs";
import { Button, type ButtonProps } from "@/components/ui/button";
import type { ApiError } from "@/lib/api-client";
import { simpleJobApi } from "./api";

/**
 * The small, reason-taking actions of the ⋯ menu (plan §5): Cancel job,
 * "Can't do this one", Take back from editor, plus Restore and Start editing
 * as plain buttons. Each refreshes the page on success.
 */

interface DialogBase {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  version: number;
  jobLabel?: string;
  onConflict?: (error: ApiError) => void;
  onDone?: () => void;
}

const CANCEL_REASONS = ["Client cancelled", "Shoot postponed", "Duplicate job", "Created by mistake"] as const;
const DECLINE_REASONS = ["Too much on this week", "Away / on leave", "Not the kind of work I do", "Raw files are missing"] as const;

/** Cancel job (reason required). */
export function CancelJobDialog({ open, onOpenChange, jobId, version, jobLabel, onConflict, onDone }: DialogBase) {
  const run = useMutationRunner();
  return (
    <ReasonDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Cancel this job?"
      description={`${jobLabel ? `${jobLabel}. ` : ""}It leaves every list but is never deleted — you can restore it later from the “Show cancelled” filter.`}
      label="Why is it cancelled?"
      placeholder="Kept in the job's history."
      confirmLabel="Cancel job"
      destructive
      suggestions={CANCEL_REASONS}
      onSubmit={async (reason) => {
        const result = await run(() => simpleJobApi.cancel(jobId, { expectedVersion: version, reason }), {
          success: "Job cancelled",
          onConflict: (err) => {
            onOpenChange(false);
            onConflict?.(err);
          },
        });
        if (result.ok) onDone?.();
        return toDialogResult(result);
      }}
    />
  );
}

/** Editor: "Can't do this one" (reason required; the job goes back to Needs editor). */
export function DeclineJobDialog({ open, onOpenChange, jobId, version, jobLabel, onConflict, onDone }: DialogBase) {
  const run = useMutationRunner();
  return (
    <ReasonDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Can't do this one?"
      description={`${jobLabel ? `${jobLabel}. ` : ""}The job goes back to the photographer to give to someone else. They will see your reason.`}
      label="Why not?"
      placeholder="e.g. Away until Monday"
      confirmLabel="Hand it back"
      suggestions={DECLINE_REASONS}
      onSubmit={async (reason) => {
        const result = await run(() => simpleJobApi.decline(jobId, { expectedVersion: version, reason }), {
          success: "Handed back",
          successDescription: "The photographer will find another editor.",
          onConflict: (err) => {
            onOpenChange(false);
            onConflict?.(err);
          },
        });
        if (result.ok) onDone?.();
        return toDialogResult(result);
      }}
    />
  );
}

/** Owner / photographer: Take back from editor (→ Needs editor). */
export function TakeBackDialog({ open, onOpenChange, jobId, version, editorName, onConflict, onDone }: DialogBase & { editorName?: string | null }) {
  const run = useMutationRunner();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Take this back from ${editorName ?? "the editor"}?`}
      description="The job goes back to Needs editor. Nothing they added is lost, and they will be told."
      confirmLabel="Take back"
      onConfirm={async () => {
        const result = await run(() => simpleJobApi.takeBack(jobId, { expectedVersion: version }), {
          success: "Taken back",
          successDescription: "The job needs an editor again.",
          onConflict: (err) => {
            onOpenChange(false);
            onConflict?.(err);
          },
        });
        if (result.ok) onDone?.();
        return result.ok ? undefined : false;
      }}
    />
  );
}

type ButtonLook = Pick<Extract<ButtonProps, { href?: undefined }>, "size" | "variant" | "className">;

interface ActionButtonProps extends ButtonLook {
  jobId: string;
  version: number;
  onConflict?: (error: ApiError) => void;
  onDone?: () => void;
}

/** Cancelled → [Restore]. */
export function RestoreButton({ jobId, version, onConflict, onDone, size, variant = "primary", className }: ActionButtonProps) {
  const run = useMutationRunner();
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      leadingIcon={<ArchiveRestore aria-hidden="true" />}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        const result = await run(() => simpleJobApi.restore(jobId, { expectedVersion: version }), { success: "Job restored", onConflict });
        setBusy(false);
        if (result.ok) onDone?.();
      }}
    >
      Restore
    </Button>
  );
}

/** Editor, With editor · Not started → [Start editing] (optional step). */
export function StartEditingButton({ jobId, version, onConflict, onDone, size, variant = "primary", className }: ActionButtonProps) {
  const run = useMutationRunner();
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      leadingIcon={<Play aria-hidden="true" />}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        const result = await run(() => simpleJobApi.startEditing(jobId, { expectedVersion: version }), { success: "Editing started", onConflict });
        setBusy(false);
        if (result.ok) onDone?.();
      }}
    >
      Start editing
    </Button>
  );
}
