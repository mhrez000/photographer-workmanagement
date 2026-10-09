"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { StatusCategory } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { ReasonDialog } from "./reason-dialog";
import type { DialogSubmitResult } from "./mutation";
import { StatusPill } from "./status-pill";

/** A status the user can pick (from an `ambiguous_target` error or the workflow). */
export interface StatusCandidate {
  id: string;
  name: string;
  key?: string;
  category?: StatusCategory;
  colour?: string | null;
  /** Edge label shown under the name ("Approve", "Request revision"…). */
  hint?: string;
}

function StatusOptionList({
  candidates,
  value,
  onChange,
  label,
}: {
  candidates: StatusCandidate[];
  value: string | null;
  onChange: (id: string) => void;
  label: string;
}) {
  const listRef = React.useRef<HTMLDivElement>(null);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[role=radio]") ?? []);
    const index = items.findIndex((el) => el === document.activeElement);
    const next = items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    next?.focus();
  };
  return (
    <div ref={listRef} role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className="flex flex-col gap-1">
      {candidates.map((c, index) => {
        const selected = value === c.id;
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={selected}
            // First field of the dialog: the modal hook focuses it on open (ahead of the reason field).
            data-autofocus={(value ? selected : index === 0) || undefined}
            onClick={() => onChange(c.id)}
            className={cn(
              "flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors focus-ring",
              selected ? "border-accent bg-accent-soft/60" : "border-border bg-surface hover:bg-surface-muted",
            )}
          >
            <span className="min-w-0 flex-1">
              {c.category ? (
                <StatusPill status={{ name: c.name, category: c.category, colour: c.colour }} size="sm" />
              ) : (
                <span className="text-sm font-medium text-ink">{c.name}</span>
              )}
              {c.hint ? <span className="mt-1 block text-xs text-ink-muted">{c.hint}</span> : null}
            </span>
            {selected ? <Check aria-hidden="true" className="size-4 text-accent-ink" /> : null}
          </button>
        );
      })}
    </div>
  );
}

export interface StatusPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidates: StatusCandidate[];
  title?: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: string;
  onPick: (statusId: string) => Promise<DialogSubmitResult> | DialogSubmitResult;
}

/** Choose one of several matching statuses (ambiguous kanban drop / category move). */
export function StatusPickerDialog({
  open,
  onOpenChange,
  candidates,
  title = "Choose a status",
  description = "This workflow has more than one status here. Pick where the job should go.",
  confirmLabel = "Move job",
  onPick,
}: StatusPickerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="sm">
      {open ? (
        <StatusPickerForm
          candidates={candidates}
          title={title}
          description={description}
          confirmLabel={confirmLabel}
          onPick={onPick}
          onOpenChange={onOpenChange}
        />
      ) : null}
    </Dialog>
  );
}

function StatusPickerForm({
  candidates,
  title,
  description,
  confirmLabel,
  onPick,
  onOpenChange,
}: Omit<StatusPickerDialogProps, "open">) {
  const [value, setValue] = React.useState<string | null>(candidates[0]?.id ?? null);
  const [submitting, setSubmitting] = React.useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!value) return;
    setSubmitting(true);
    try {
      const result = await onPick(value);
      if (result === true) onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <form onSubmit={submit} className="contents">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
      </DialogHeader>
      <DialogBody className="pb-5">
        <StatusOptionList candidates={candidates} value={value} onChange={setValue} label="Target status" />
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" loading={submitting} disabled={!value}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

export interface TransitionOverrideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every status of the job's workflow (current one is excluded automatically). */
  statuses: StatusCandidate[];
  currentStatusId?: string;
  onSubmit: (input: { statusId: string; reason: string }) => Promise<DialogSubmitResult> | DialogSubmitResult;
}

/** Owner/manager escape hatch: move a job to any status with a mandatory, audited reason. */
export function TransitionOverrideDialog({ open, onOpenChange, statuses, currentStatusId, onSubmit }: TransitionOverrideDialogProps) {
  const candidates = statuses.filter((s) => s.id !== currentStatusId);
  const [picked, setPicked] = React.useState<string | null>(null);
  const value = picked && candidates.some((c) => c.id === picked) ? picked : null;
  return (
    <ReasonDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setPicked(null);
        onOpenChange(next);
      }}
      title="Move to any status"
      description="Skips the normal workflow rules. The move is recorded as an override in the job history, with your reason."
      confirmLabel="Override and move"
      confirmDisabled={!value}
      onSubmit={(reason) => (value ? onSubmit({ statusId: value, reason }) : false)}
    >
      <div className="max-h-64 overflow-y-auto pr-1 scrollbar-thin">
        <StatusOptionList candidates={candidates} value={value} onChange={setPicked} label="Target status" />
      </div>
    </ReasonDialog>
  );
}
