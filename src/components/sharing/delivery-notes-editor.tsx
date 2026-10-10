"use client";

import * as React from "react";
import { Archive, FileText, Plus } from "lucide-react";
import { RelativeTime } from "@/components/jobs/relative-time";
import { firstFieldErrors, useMutationRunner } from "@/components/jobs/mutation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api-client";
import type { SharingNote } from "@/lib/sharing";

export interface DeliveryNotesEditorProps {
  jobId: string;
  clientName: string;
  notes: SharingNote[];
  canAdd: boolean;
  timeZone: string;
}

/** Delivery notes — the one note kind the client sees (docs/ROLES.md §1.1 `delivery`). */
export function DeliveryNotesEditor({ jobId, clientName, notes, canAdd, timeZone }: DeliveryNotesEditorProps) {
  const run = useMutationRunner();
  const [adding, setAdding] = React.useState(false);
  const [body, setBody] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    setPending(true);
    const res = await run(() => api.post(`/api/jobs/${jobId}/notes`, { kind: "delivery", body: text }), {
      success: "Delivery note added",
      successDescription: `${clientName} sees it on this job in their portal.`,
    });
    setPending(false);
    if (res.ok) {
      setBody("");
      setAdding(false);
      setError(null);
    } else setError(firstFieldErrors(res.fieldErrors).body ?? null);
  }

  async function archive(note: SharingNote) {
    await run(() => api.post(`/api/notes/${note.id}/archive`, { expectedVersion: note.version }), { success: "Delivery note archived" });
  }

  return (
    <div className="flex flex-col gap-2.5">
      {notes.length === 0 && !adding ? <p className="text-sm text-ink-muted">No delivery notes. The client sees these with their files.</p> : null}
      {notes.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-md border border-border bg-surface-sunken/60 px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-xs text-ink-muted">
                <FileText aria-hidden="true" className="size-3.5" />
                <span className="font-medium text-ink-secondary">{n.authorName}</span>
                <RelativeTime value={n.createdAt} timeZone={timeZone} />
                {n.canArchive ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-6 px-1.5 text-ink-muted"
                    aria-label="Archive delivery note"
                    leadingIcon={<Archive aria-hidden="true" />}
                    onClick={() => void archive(n)}
                  >
                    Archive
                  </Button>
                ) : null}
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{n.body}</p>
            </li>
          ))}
        </ul>
      ) : null}
      {canAdd ? (
        adding ? (
          <form onSubmit={add} className="flex flex-col gap-2">
            <label htmlFor={`delivery-note-${jobId}`} className="text-sm font-medium text-ink">
              Delivery note — visible to the client
            </label>
            <Textarea
              id={`delivery-note-${jobId}`}
              rows={3}
              autoFocus
              value={body}
              invalid={Boolean(error)}
              onChange={(e) => setBody(e.target.value)}
              placeholder="e.g. Your gallery password is on the first page. Twilight images are in the second folder."
              maxLength={10_000}
            />
            {error ? <p className="text-sm text-danger-fg">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={pending} disabled={!body.trim()}>
                Add note
              </Button>
            </div>
          </form>
        ) : (
          <Button type="button" variant="outline" size="sm" className="self-start" leadingIcon={<Plus aria-hidden="true" />} onClick={() => setAdding(true)}>
            Add delivery note
          </Button>
        )
      ) : null}
    </div>
  );
}
