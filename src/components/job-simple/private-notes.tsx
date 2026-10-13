"use client";

import * as React from "react";
import { Lock, Plus } from "lucide-react";
import { useMutationRunner, firstFieldErrors } from "@/components/jobs";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api-client";
import type { NoteKind } from "@/lib/constants";
import { formatDateShort, formatDateTime } from "@/lib/dates";
import type { NoteView } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface PrivateNotesProps {
  jobId: string;
  notes: NoteView[];
  /** The private kind the viewer may add ("internal" preferred, else "client"), or null. */
  addAsKind: Extract<NoteKind, "internal" | "client"> | null;
  timeZone: string;
  className?: string;
}

/**
 * Private notes (plan §5): owners and photographers only, in a clearly tinted
 * box. Never a toggle inside the editor thread, so nothing private can reach
 * an editor by one wrong click.
 */
export function PrivateNotes({ jobId, notes, addAsKind, timeZone, className }: PrivateNotesProps) {
  const run = useMutationRunner();
  const [open, setOpen] = React.useState(false);
  const [body, setBody] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const ordered = [...notes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = body.trim();
    if (!text) {
      setError("Write the note first.");
      return;
    }
    if (!addAsKind) return;
    setBusy(true);
    const result = await run(() => api.post(`/api/jobs/${jobId}/notes`, { kind: addAsKind, body: text, isPinned: false }), { success: "Private note added" });
    setBusy(false);
    if (result.ok) {
      setBody("");
      setOpen(false);
      setError(null);
    } else if (result.fieldErrors) {
      setError(firstFieldErrors(result.fieldErrors).body ?? "Please check the note.");
    }
  };

  return (
    <section id="private-notes" aria-labelledby="private-notes-title" className={cn("rounded-lg border border-warning/30 bg-warning-soft/40 p-4 sm:p-5", className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="private-notes-title" className="flex items-center gap-2 text-md font-semibold text-ink">
            <Lock aria-hidden="true" className="size-4 text-warning-fg" />
            Private notes
          </h2>
          <p className="mt-0.5 text-sm text-ink-muted">Only owners and photographers see these. Editors and the client never do.</p>
        </div>
        {addAsKind && !open ? (
          <Button variant="outline" size="sm" leadingIcon={<Plus aria-hidden="true" />} onClick={() => setOpen(true)}>
            Add a private note
          </Button>
        ) : null}
      </div>

      {ordered.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-3">
          {ordered.map((n) => (
            <li key={n.id} className="flex gap-3">
              <Avatar name={n.author.name} colour={n.author.avatarColour || undefined} size="sm" className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink-muted">
                  <span className="font-medium text-ink">{n.author.name}</span>
                  <time dateTime={n.createdAt} title={formatDateTime(n.createdAt, timeZone)}>
                    {formatDateShort(n.createdAt, timeZone)}
                  </time>
                  {n.kind === "client" ? <span className="rounded-full border border-warning/40 px-1.5 text-2xs">about the client</span> : null}
                </p>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">{n.body}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : !open ? (
        <p className="mt-3 text-sm text-ink-muted">Nothing private yet.</p>
      ) : null}

      {open && addAsKind ? (
        <form onSubmit={submit} noValidate className="mt-4 flex flex-col gap-2">
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
            placeholder="Pricing, access codes, how this client likes things done…"
            aria-label="New private note"
            autoFocus
            invalid={Boolean(error)}
            className="bg-surface"
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
            <Button type="submit" size="sm" loading={busy} leadingIcon={<Lock aria-hidden="true" />}>
              Save private note
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
