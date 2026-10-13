"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { useMutationRunner, firstFieldErrors } from "@/components/jobs";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api-client";
import type { NoteKind } from "@/lib/constants";
import { cn } from "@/lib/utils";

export interface InstructionComposerProps {
  jobId: string;
  /** Recorded as this note kind (photographer / editor); never a private kind. */
  kind: NoteKind;
  /** Set when the EDITOR is writing: the button reads "Add a note for Mo" and the note goes back to them. */
  forPhotographer?: string | null;
  className?: string;
}

/** "Add to the instructions" (owner / photographer) or "Add a note for Mo" (editor): one textarea that posts a note everyone on the job can read. */
export function InstructionComposer({ jobId, kind, forPhotographer = null, className }: InstructionComposerProps) {
  const run = useMutationRunner();
  const [open, setOpen] = React.useState(false);
  const [body, setBody] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  if (!open) {
    return (
      <Button variant="outline" size="sm" leadingIcon={<Plus aria-hidden="true" />} onClick={() => setOpen(true)} className={className}>
        {forPhotographer ? `Add a note for ${forPhotographer}` : "Add to the instructions"}
      </Button>
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = body.trim();
    if (!text) {
      setError("Write the instruction first.");
      return;
    }
    setBusy(true);
    const result = await run(() => api.post(`/api/jobs/${jobId}/notes`, { kind, body: text, isPinned: false }), { success: forPhotographer ? "Note added" : "Added to the instructions" });
    setBusy(false);
    if (result.ok) {
      setBody("");
      setOpen(false);
      setError(null);
    } else if (result.fieldErrors) {
      setError(firstFieldErrors(result.fieldErrors).body ?? "Please check the text.");
    }
  };

  return (
    <form onSubmit={submit} noValidate className={cn("flex flex-col gap-2", className)}>
      <Textarea
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit(e);
        }}
        rows={3}
        maxLength={5000}
        placeholder={forPhotographer ? `Anything ${forPhotographer} should know about how you edited this…` : "Anything the editor should know — style, must-have shots, what to leave out…"}
        aria-label={forPhotographer ? `Add a note for ${forPhotographer}` : "Add to the instructions"}
        autoFocus
        invalid={Boolean(error)}
      />
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" size="sm" loading={busy}>
          Add
        </Button>
      </div>
    </form>
  );
}
