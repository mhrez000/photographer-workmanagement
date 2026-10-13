"use client";

import * as React from "react";
import { RotateCcw } from "lucide-react";
import { useMutationRunner, firstFieldErrors } from "@/components/jobs";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";
import type { ApiError } from "@/lib/api-client";
import { SIMPLE_CHANGES_DEFAULT_DAYS, SIMPLE_CHANGE_CHIPS } from "@/lib/constants";
import { addCivilDays, formatDate, todayCivil } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { simpleJobApi } from "./api";

export interface AskForChangesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  version: number;
  /** The editor who gets the note ("Sam"). */
  editorName?: string | null;
  jobLabel?: string;
  timeZone: string;
  onConflict?: (error: ApiError) => void;
  onDone?: () => void;
}

/** The chip's line as it is written into the box ("Sky" → "Sky."). */
function chipLine(chip: string): string {
  return `${chip}.`;
}

/** Appends the chip's words to the note (own line) so a tap really adds something to send. */
export function addChipToNote(note: string, chip: string): string {
  const line = chipLine(chip);
  if (note.split("\n").some((l) => l.trim() === line)) return note;
  const trimmedEnd = note.replace(/\s+$/, "");
  return trimmedEnd ? `${trimmedEnd}\n${line}` : line;
}

/** Removes the chip's own line again (only if it is still exactly as added). */
export function removeChipFromNote(note: string, chip: string): string {
  const line = chipLine(chip);
  return note
    .split("\n")
    .filter((l) => l.trim() !== line)
    .join("\n");
}

/**
 * One box: "What needs changing?" (required), tap-to-add chips that write their
 * words INTO the box (so a tap alone is a valid request), and "Needed back by"
 * (default tomorrow) behind a small Change link (plan §5).
 */
export function AskForChangesDialog(props: AskForChangesDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange} size="md">
      {props.open ? <ChangesForm {...props} /> : null}
    </Dialog>
  );
}

function ChangesForm({ onOpenChange, jobId, version, editorName, jobLabel, timeZone, onConflict, onDone }: AskForChangesDialogProps) {
  const run = useMutationRunner();
  const defaultDay = React.useMemo(() => addCivilDays(todayCivil(timeZone), SIMPLE_CHANGES_DEFAULT_DAYS), [timeZone]);
  const [note, setNote] = React.useState("");
  const [chips, setChips] = React.useState<string[]>([]);
  const [neededBy, setNeededBy] = React.useState(defaultDay);
  const [changingDate, setChangingDate] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [dateError, setDateError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const toggleChip = (chip: string) => {
    const on = chips.includes(chip);
    setChips((prev) => (on ? prev.filter((c) => c !== chip) : [...prev, chip]));
    setNote((prev) => (on ? removeChipFromNote(prev, chip) : addChipToNote(prev, chip)));
    if (error) setError(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = note.trim();
    if (!text) {
      setError("Say what needs changing — the editor reads this.");
      return;
    }
    setBusy(true);
    setError(null);
    setDateError(null);
    const result = await run(
      () =>
        simpleJobApi.askForChanges(jobId, {
          expectedVersion: version,
          note: text,
          ...(chips.length > 0 ? { chips } : {}),
          neededBy: neededBy || null,
        }),
      {
        success: "Changes asked",
        successDescription: editorName ? `${editorName} has your note.` : undefined,
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
      if (f.neededBy) setDateError(f.neededBy);
      setError(f.note ?? f.chips ?? (f.neededBy ? null : Object.values(f)[0] ?? "Please check the form."));
    }
  };

  return (
    <form onSubmit={submit} noValidate className="contents">
      <DialogHeader>
        <DialogTitle>Ask for changes</DialogTitle>
        <DialogDescription>
          {jobLabel ? <span className="font-medium text-ink-secondary">{jobLabel}. </span> : null}
          The job goes back to {editorName ?? "the editor"} with your note. They send it again when it is fixed.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4 pb-5">
        <FormField label="What needs changing?" required error={error ?? undefined}>
          <Textarea
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              if (error) setError(null);
            }}
            rows={4}
            maxLength={5000}
            placeholder="e.g. Brighten the kitchen, straighten the verticals in the lounge, remove the bin from the front shot."
            data-autofocus
          />
        </FormField>
        <div role="group" aria-label="Common changes" className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-ink-muted">Tap to add:</span>
          {SIMPLE_CHANGE_CHIPS.map((chip) => {
            const on = chips.includes(chip);
            return (
              <button
                key={chip}
                type="button"
                aria-pressed={on}
                onClick={() => toggleChip(chip)}
                className={cn(
                  "h-7 rounded-full border px-2.5 text-xs transition-colors focus-ring",
                  on ? "border-accent bg-accent-soft text-accent-ink" : "border-border bg-surface text-ink-secondary hover:bg-surface-muted",
                )}
              >
                {chip}
              </button>
            );
          })}
        </div>
        <div className="text-sm text-ink-muted">
          {changingDate ? (
            <FormField label="Needed back by" error={dateError ?? undefined} className="max-w-xs">
              <DateInput
                value={neededBy}
                min={todayCivil(timeZone)}
                onChange={(e) => {
                  setNeededBy(e.target.value);
                  if (dateError) setDateError(null);
                }}
                autoFocus
              />
            </FormField>
          ) : (
            <p className="flex flex-wrap items-center gap-x-2">
              <span>
                Needed back by <span className="font-medium text-ink">{neededBy === defaultDay ? `tomorrow (${formatDate(neededBy, "UTC")})` : formatDate(neededBy, "UTC")}</span>
              </span>
              <button type="button" onClick={() => setChangingDate(true)} className="text-accent-ink underline-offset-2 hover:underline focus-ring rounded-xs">
                Change
              </button>
            </p>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" leadingIcon={<RotateCcw aria-hidden="true" />} loading={busy}>
          Ask for changes
        </Button>
      </DialogFooter>
    </form>
  );
}
