"use client";

import * as React from "react";
import { Check, Search } from "lucide-react";
import { useMutationRunner } from "@/components/jobs";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage, type ApiError } from "@/lib/api-client";
import type { EditorPickerOption } from "@/lib/types";
import { cn } from "@/lib/utils";
import { simpleJobApi } from "./api";

export interface AssignEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  version: number;
  /** "assign" (Needs editor) or "change" (the job already has an editor). */
  mode?: "assign" | "change";
  /** The editor who holds the job now (marked "Current", cannot be re-picked). */
  currentEditorId?: string | null;
  /** "12 Ocean St · Ray White" — shown under the title. */
  jobLabel?: string;
  /** Picker rows from the server; when omitted they are fetched (`GET /api/editors/options`). */
  options?: EditorPickerOption[] | null;
  onConflict?: (error: ApiError) => void;
  /** After a successful assignment (the page is refreshed automatically). */
  onDone?: (editorId: string) => void;
}

/** "Who should edit this?" — one row per editor: On their desk 3 · Late 1 (· 4 of 6). */
export function AssignEditorDialog(props: AssignEditorDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange} size="md">
      {props.open ? <PickerForm {...props} /> : null}
    </Dialog>
  );
}

function useEditorOptions(given: EditorPickerOption[] | null | undefined) {
  const [state, setState] = React.useState<{ rows: EditorPickerOption[] | null; error: string | null }>({ rows: given ?? null, error: null });
  React.useEffect(() => {
    if (given) return undefined;
    const controller = new AbortController();
    simpleJobApi
      .editorOptions(controller.signal)
      .then((rows) => setState({ rows: Array.isArray(rows) ? rows : [], error: null }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({ rows: [], error: errorMessage(err) });
      });
    return () => controller.abort();
  }, [given]);
  return state;
}

function PickerForm({ onOpenChange, jobId, version, mode = "assign", currentEditorId = null, jobLabel, options, onConflict, onDone }: AssignEditorDialogProps) {
  const run = useMutationRunner();
  const { rows, error } = useEditorOptions(options);
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  const filtered = React.useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    const list = q ? rows.filter((r) => r.editor.name.toLowerCase().includes(q)) : rows;
    // Current holder first, then the emptiest desk, then by name.
    return [...list].sort((a, b) => {
      if (a.editor.id === currentEditorId) return -1;
      if (b.editor.id === currentEditorId) return 1;
      return a.onDesk - b.onDesk || a.late - b.late || a.editor.name.localeCompare(b.editor.name);
    });
  }, [rows, query, currentEditorId]);

  const picked = rows?.find((r) => r.editor.id === selected) ?? null;
  const disabled = !picked || picked.editor.id === currentEditorId;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!picked || disabled) return;
    setSubmitting(true);
    setFormError(null);
    const result = await run(
      () =>
        mode === "change"
          ? simpleJobApi.changeEditor(jobId, { expectedVersion: version, editorId: picked.editor.id })
          : simpleJobApi.assignEditor(jobId, { expectedVersion: version, editorId: picked.editor.id }),
      {
        success: `Given to ${picked.editor.name}`,
        onConflict: (err) => {
          onOpenChange(false);
          onConflict?.(err);
        },
      },
    );
    setSubmitting(false);
    if (result.ok) {
      onOpenChange(false);
      onDone?.(picked.editor.id);
    } else if (result.fieldErrors) {
      setFormError(Object.values(result.fieldErrors).flat()[0] ?? "Please check the form.");
    }
  };

  const onListKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[role=radio]") ?? []);
    const index = items.findIndex((el) => el === document.activeElement);
    items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };

  return (
    <form onSubmit={submit} noValidate className="contents">
      <DialogHeader>
        <DialogTitle>{mode === "change" ? "Change editor" : "Who should edit this?"}</DialogTitle>
        <DialogDescription>
          {jobLabel ? <span className="font-medium text-ink-secondary">{jobLabel}. </span> : null}
          {mode === "change" ? "The new editor gets the job as it is now; the history keeps both names." : "They will be told straight away and the job moves to With editor."}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-3 pb-5">
        {rows && rows.length > 6 ? (
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search editors…"
            leading={<Search aria-hidden="true" />}
            aria-label="Search editors"
            data-autofocus
          />
        ) : null}
        <div ref={listRef} role="radiogroup" aria-label="Choose an editor" onKeyDown={onListKeyDown} className="-mx-1 max-h-[min(22rem,50dvh)] space-y-1 overflow-y-auto px-1 scrollbar-thin">
          {rows === null ? (
            Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-14 w-full rounded-md" />)
          ) : error ? (
            <p role="alert" className="rounded-md border border-danger/25 bg-danger-soft/60 px-3 py-2 text-sm text-danger-fg">
              {error}
            </p>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-ink-muted">{query ? `No editors match “${query}”.` : "No editors yet. Invite one from Settings → People."}</p>
          ) : (
            filtered.map((row) => (
              <EditorRow key={row.editor.id} row={row} isCurrent={row.editor.id === currentEditorId} selected={selected === row.editor.id} onSelect={() => setSelected(row.editor.id)} />
            ))
          )}
        </div>
        {formError ? (
          <p role="alert" className="text-sm text-danger">
            {formError}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" loading={submitting} disabled={disabled}>
          {mode === "change" ? "Change editor" : "Assign editor"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** "On their desk 3 · Late 1" (· "4 of 6", amber when full). */
export function EditorDeskLine({ row, className }: { row: EditorPickerOption; className?: string }) {
  return (
    <span className={cn("flex flex-wrap items-center gap-x-1.5 text-xs text-ink-muted numeric", className)}>
      <span>
        On their desk{" "}
        <span className={cn("font-medium", row.full ? "text-warning-fg" : "text-ink-secondary")}>
          {row.usualCapacity !== null ? `${row.onDesk} of ${row.usualCapacity}` : row.onDesk}
        </span>
      </span>
      <span aria-hidden="true">·</span>
      <span>
        Late <span className={cn("font-medium", row.late > 0 ? "text-danger-fg" : "text-ink-secondary")}>{row.late}</span>
      </span>
    </span>
  );
}

function EditorRow({ row, isCurrent, selected, onSelect }: { row: EditorPickerOption; isCurrent: boolean; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={isCurrent || undefined}
      onClick={isCurrent ? undefined : onSelect}
      className={cn(
        "flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors focus-ring",
        selected ? "border-accent bg-accent-soft/60" : "border-transparent hover:bg-surface-muted",
        isCurrent && "cursor-default opacity-70",
      )}
    >
      <Avatar name={row.editor.name} size="md" colour={row.editor.avatarColour || undefined} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-ink">{row.editor.name}</span>
          {isCurrent ? (
            <Badge size="sm" variant="accent">
              Current
            </Badge>
          ) : row.full ? (
            <Badge size="sm" variant="warning">
              Full
            </Badge>
          ) : null}
        </span>
        <EditorDeskLine row={row} className="mt-0.5" />
      </span>
      {selected ? <Check aria-hidden="true" className="size-4 shrink-0 text-accent-ink" /> : null}
    </button>
  );
}
