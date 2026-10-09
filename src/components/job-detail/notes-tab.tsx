"use client";

import * as React from "react";
import { Archive, ArchiveRestore, ChevronRight, FilePlus2, FileText, History, Lock, Pencil, Pin, PinOff } from "lucide-react";
import { ConflictDialog, useMutationRunner, firstFieldErrors } from "@/components/jobs";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { IconButton } from "@/components/ui/icon-button";
import { Select } from "@/components/ui/select";
import { Sheet, SheetBody, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import { api, ApiError, errorMessage } from "@/lib/api-client";
import { NOTE_KIND_META, NOTE_KINDS, type NoteKind } from "@/lib/constants";
import { formatDateTime, formatRelative } from "@/lib/dates";
import type { NoteHistoryEntry, NoteView } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface NotePermissions {
  canEdit: boolean;
  canArchive: boolean;
}

export interface NotesTabProps {
  jobId: string;
  notes: NoteView[];
  readableKinds: NoteKind[];
  canAddKinds: NoteKind[];
  permissions: Record<string, NotePermissions>;
  timeZone: string;
  initialKind?: NoteKind | null;
}

type Filter = NoteKind | "all";

/* ------------------------------------------------------------------ */
/*  Composer                                                            */
/* ------------------------------------------------------------------ */

function NoteComposer({ jobId, kinds, defaultKind, onDone }: { jobId: string; kinds: NoteKind[]; defaultKind: NoteKind; onDone?: () => void }) {
  const run = useMutationRunner();
  const [kind, setKind] = React.useState<NoteKind>(defaultKind);
  const [body, setBody] = React.useState("");
  const [pinned, setPinned] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Follow the selected filter tab.
  const [lastDefault, setLastDefault] = React.useState(defaultKind);
  if (lastDefault !== defaultKind) {
    setLastDefault(defaultKind);
    setKind(defaultKind);
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!body.trim()) {
      setError("Write the note first.");
      return;
    }
    setBusy(true);
    const result = await run(() => api.post(`/api/jobs/${jobId}/notes`, { kind, body: body.trim(), isPinned: pinned }), {
      success: `${NOTE_KIND_META[kind].label.replace(/s$/, "")} added`,
    });
    setBusy(false);
    if (result.ok) {
      setBody("");
      setPinned(false);
      setError(null);
      onDone?.();
    } else if (result.fieldErrors) {
      const f = firstFieldErrors(result.fieldErrors);
      setError(f.body ?? Object.values(f)[0] ?? null);
    }
  };

  return (
    <Card className="p-4">
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <FormField label="New note" error={error ?? undefined}>
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
            placeholder={kind === "internal" ? "Visible to owners and managers only…" : "Shoot details, editing direction, client preferences…"}
          />
        </FormField>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {kinds.length > 1 ? (
              <Select size="sm" value={kind} onChange={(e) => setKind(e.target.value as NoteKind)} aria-label="Note kind" wrapperClassName="w-auto" options={kinds.map((k) => ({ value: k, label: NOTE_KIND_META[k].label }))} />
            ) : (
              <Badge variant="outline" size="sm">
                {NOTE_KIND_META[kind].label}
              </Badge>
            )}
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-ink-secondary">
              <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} className="size-3.5 accent-(--accent)" />
              Pin to top
            </label>
          </div>
          <Button type="submit" size="sm" loading={busy} leadingIcon={<FilePlus2 aria-hidden="true" />}>
            Add note
          </Button>
        </div>
      </form>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  History drawer                                                      */
/* ------------------------------------------------------------------ */

const HISTORY_LABELS: Record<NoteHistoryEntry["eventType"], string> = {
  "note.added": "Added",
  "note.edited": "Edited",
  "note.archived": "Archived",
  "note.restored": "Restored",
};

function NoteHistorySheet({ note, onOpenChange, timeZone }: { note: NoteView | null; onOpenChange: (open: boolean) => void; timeZone: string }) {
  const [state, setState] = React.useState<{ id: string; entries: NoteHistoryEntry[] | null; error: string | null } | null>(null);
  const id = note?.id ?? null;

  React.useEffect(() => {
    if (!id) return undefined;
    const controller = new AbortController();
    api
      .get<NoteHistoryEntry[]>(`/api/notes/${id}/history`, { signal: controller.signal })
      .then((entries) => setState({ id, entries, error: null }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({ id, entries: null, error: errorMessage(err) });
      });
    return () => controller.abort();
  }, [id]);

  const current = state && state.id === id ? state : null;
  const entries = current?.entries ? [...current.entries].reverse() : null;

  return (
    <Sheet open={note !== null} onOpenChange={onOpenChange} side="right" size="md">
      <SheetHeader>
        <SheetTitle>Note history</SheetTitle>
        <SheetDescription>{note ? `${NOTE_KIND_META[note.kind].label} · edited ${note.editCount} ${note.editCount === 1 ? "time" : "times"}. Every version is kept.` : null}</SheetDescription>
      </SheetHeader>
      <SheetBody>
        {current?.error ? (
          <p role="alert" className="text-sm text-danger">
            {current.error}
          </p>
        ) : entries === null ? (
          <div className="flex flex-col gap-4" role="status" aria-label="Loading history">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex flex-col gap-2">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-14 w-full" />
              </div>
            ))}
          </div>
        ) : entries.length === 0 ? (
          <p className="text-sm text-ink-muted">No recorded changes.</p>
        ) : (
          <ol className="relative ml-2 border-l border-border pl-5">
            {entries.map((e) => (
              <li key={e.eventId} className="relative pb-6 last:pb-0">
                <span aria-hidden="true" className="absolute -left-[26px] top-1 size-2.5 rounded-full bg-accent ring-4 ring-surface-raised" />
                <p className="text-xs text-ink-muted">
                  <span className="font-medium text-ink">{HISTORY_LABELS[e.eventType]}</span> by {e.actor?.name ?? "System"} ·{" "}
                  <time dateTime={e.at} className="numeric">
                    {formatDateTime(e.at, timeZone)}
                  </time>
                </p>
                {e.eventType === "note.edited" && e.previousBody !== null ? (
                  <div className="mt-2 flex flex-col gap-1.5 text-sm">
                    <p className="whitespace-pre-wrap rounded-md bg-danger-soft/60 px-3 py-2 text-ink-secondary line-through decoration-danger/40">{e.previousBody}</p>
                    <p className="whitespace-pre-wrap rounded-md bg-success-soft/70 px-3 py-2 text-ink">{e.newBody}</p>
                  </div>
                ) : e.newBody ?? e.previousBody ? (
                  <p className="mt-2 whitespace-pre-wrap rounded-md bg-surface-sunken px-3 py-2 text-sm text-ink-secondary">{e.newBody ?? e.previousBody}</p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </SheetBody>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ */
/*  Note card                                                           */
/* ------------------------------------------------------------------ */

function NoteCard({
  note,
  perms,
  timeZone,
  onHistory,
  onConflict,
}: {
  note: NoteView;
  perms: NotePermissions | undefined;
  timeZone: string;
  onHistory: (note: NoteView) => void;
  onConflict: (err: ApiError) => void;
}) {
  const run = useMutationRunner();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(note.body);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const archived = note.archivedAt !== null;

  const patch = async (key: string, body: Record<string, unknown>, success: string) => {
    setBusy(key);
    const result = await run(() => api.patch(`/api/notes/${note.id}`, { expectedVersion: note.version, ...body }), { success, onConflict });
    setBusy(null);
    return result;
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) {
      setError("A note cannot be empty — archive it instead.");
      return;
    }
    if (draft.trim() === note.body) {
      setEditing(false);
      return;
    }
    const result = await patch("save", { body: draft.trim() }, "Note updated");
    if (result.ok) setEditing(false);
    else if (result.fieldErrors) setError(firstFieldErrors(result.fieldErrors).body ?? "Please check the note.");
  };

  const archiveOrRestore = async () => {
    setBusy("archive");
    await run(() => api.post(`/api/notes/${note.id}/${archived ? "restore" : "archive"}`, { expectedVersion: note.version }), {
      success: archived ? "Note restored" : "Note archived",
      onConflict,
    });
    setBusy(null);
  };

  return (
    <li>
      <Card className={cn("p-4", note.isPinned && !archived && "border-accent/30 bg-accent-soft/25", archived && "bg-surface-sunken shadow-none")}>
        <div className="flex items-start gap-3">
          <Avatar name={note.author.name} colour={note.author.avatarColour || undefined} size="sm" className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-medium text-ink">{note.author.name}</span>
              <Badge variant={note.kind === "internal" ? "warning" : "outline"} size="sm">
                {note.kind === "internal" ? <Lock aria-hidden="true" /> : null}
                {NOTE_KIND_META[note.kind].label}
              </Badge>
              {note.isPinned ? (
                <span className="inline-flex items-center gap-1 text-2xs font-medium text-accent-ink">
                  <Pin aria-hidden="true" className="size-3" /> Pinned
                </span>
              ) : null}
              <time dateTime={note.createdAt} title={formatDateTime(note.createdAt, timeZone)} className="text-xs text-ink-subtle numeric" suppressHydrationWarning>
                {formatRelative(note.createdAt)}
              </time>
              {note.editCount > 0 ? (
                <button type="button" onClick={() => onHistory(note)} className="inline-flex items-center gap-1 rounded-xs text-xs text-ink-muted underline-offset-2 hover:text-ink hover:underline focus-ring">
                  <History aria-hidden="true" className="size-3" />
                  edited {note.editCount} {note.editCount === 1 ? "time" : "times"}
                  {note.lastEditedBy ? ` · last by ${note.lastEditedBy.name}` : ""}
                </button>
              ) : null}
            </div>

            {editing ? (
              <form onSubmit={save} className="mt-2 flex flex-col gap-2">
                <Textarea
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    if (error) setError(null);
                  }}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void save(e);
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setEditing(false);
                    }
                  }}
                  rows={4}
                  autoFocus
                  aria-label="Edit note"
                  invalid={Boolean(error)}
                />
                {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => { setEditing(false); setDraft(note.body); }}>
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" loading={busy === "save"}>
                    Save
                  </Button>
                </div>
              </form>
            ) : (
              <p className={cn("mt-1.5 whitespace-pre-wrap text-sm leading-relaxed", archived ? "text-ink-muted" : "text-ink-secondary")}>{note.body}</p>
            )}
            {archived ? <p className="mt-2 text-2xs text-ink-subtle">Archived {formatDateTime(note.archivedAt, timeZone)}</p> : null}
          </div>

          {!editing && (perms?.canEdit || perms?.canArchive) ? (
            <div className="flex shrink-0 items-center gap-0.5">
              {perms.canEdit && !archived ? (
                <>
                  <Tooltip content={note.isPinned ? "Unpin" : "Pin to top"}>
                    <IconButton label={note.isPinned ? "Unpin note" : "Pin note"} size="sm" variant="ghost" loading={busy === "pin"} onClick={() => void patch("pin", { isPinned: !note.isPinned }, note.isPinned ? "Note unpinned" : "Note pinned")}>
                      {note.isPinned ? <PinOff /> : <Pin />}
                    </IconButton>
                  </Tooltip>
                  <Tooltip content="Edit">
                    <IconButton label="Edit note" size="sm" variant="ghost" onClick={() => setEditing(true)}>
                      <Pencil />
                    </IconButton>
                  </Tooltip>
                </>
              ) : null}
              {perms.canArchive ? (
                <Tooltip content={archived ? "Restore" : "Archive"}>
                  <IconButton label={archived ? "Restore note" : "Archive note"} size="sm" variant="ghost" loading={busy === "archive"} onClick={() => void archiveOrRestore()}>
                    {archived ? <ArchiveRestore /> : <Archive />}
                  </IconButton>
                </Tooltip>
              ) : null}
            </div>
          ) : null}
        </div>
      </Card>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab                                                                 */
/* ------------------------------------------------------------------ */

/** Structured notes by kind: add / edit / pin / archive, with an edit-history drawer. */
export function NotesTab({ jobId, notes, readableKinds, canAddKinds, permissions, timeZone, initialKind }: NotesTabProps) {
  const [filter, setFilter] = React.useState<Filter>(initialKind && readableKinds.includes(initialKind) ? initialKind : "all");
  const [historyNote, setHistoryNote] = React.useState<NoteView | null>(null);
  const [conflict, setConflict] = React.useState<ApiError | null>(null);

  const active = notes.filter((n) => n.archivedAt === null);
  const archived = notes.filter((n) => n.archivedAt !== null);
  const visible = active.filter((n) => filter === "all" || n.kind === filter);
  const archivedVisible = archived.filter((n) => filter === "all" || n.kind === filter);
  const kinds = NOTE_KINDS.filter((k) => readableKinds.includes(k));
  const composerKinds = filter === "all" ? canAddKinds : canAddKinds.filter((k) => k === filter);
  const defaultKind = composerKinds[0];

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label="Note kinds" className="flex flex-wrap gap-1.5">
        {(["all", ...kinds] as Filter[]).map((k) => {
          const count = k === "all" ? active.length : active.filter((n) => n.kind === k).length;
          const selected = filter === k;
          return (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setFilter(k)}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors focus-ring",
                selected ? "border-ink bg-ink text-ink-inverse" : "border-border bg-surface text-ink-secondary hover:border-border-hover hover:text-ink",
              )}
            >
              {k === "internal" ? <Lock aria-hidden="true" className="size-3" /> : null}
              {k === "all" ? "All notes" : NOTE_KIND_META[k].label}
              <span className={cn("numeric text-xs", selected ? "text-ink-inverse/70" : "text-ink-subtle")}>{count}</span>
            </button>
          );
        })}
      </div>

      {filter === "internal" ? (
        <p className="flex items-center gap-2 rounded-md bg-warning-soft/60 px-3 py-2 text-xs text-warning-fg">
          <Lock aria-hidden="true" className="size-3.5" /> Internal notes are visible to owners and managers only (and the job&apos;s photographer).
        </p>
      ) : null}

      {defaultKind ? <NoteComposer jobId={jobId} kinds={composerKinds} defaultKind={defaultKind} /> : null}

      {visible.length === 0 ? (
        <Card>
          <EmptyState
            size="sm"
            icon={FileText}
            title={filter === "all" ? "No notes yet" : `No ${NOTE_KIND_META[filter].label.toLowerCase()}`}
            description={
              defaultKind
                ? "Capture shoot details, editing direction or client preferences. Notes stay with the job and every edit is kept."
                : "Notes added by the photographer, editor or studio will appear here."
            }
          />
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {visible.map((n) => (
            <NoteCard key={`${n.id}-${n.version}`} note={n} perms={permissions[n.id]} timeZone={timeZone} onHistory={setHistoryNote} onConflict={setConflict} />
          ))}
        </ul>
      )}

      {archivedVisible.length > 0 ? (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-xs py-1 text-sm font-medium text-ink-muted hover:text-ink focus-ring [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden="true" className="size-4 transition-transform group-open:rotate-90" />
            Archived ({archivedVisible.length})
          </summary>
          <ul className="mt-3 flex flex-col gap-3">
            {archivedVisible.map((n) => (
              <NoteCard key={`${n.id}-${n.version}`} note={n} perms={permissions[n.id]} timeZone={timeZone} onHistory={setHistoryNote} onConflict={setConflict} />
            ))}
          </ul>
        </details>
      ) : null}

      <NoteHistorySheet note={historyNote} onOpenChange={(open) => (!open ? setHistoryNote(null) : undefined)} timeZone={timeZone} />
      <ConflictDialog open={conflict !== null} onOpenChange={(open) => (!open ? setConflict(null) : undefined)} error={conflict ?? undefined} entity="note" timeZone={timeZone} />
    </div>
  );
}
