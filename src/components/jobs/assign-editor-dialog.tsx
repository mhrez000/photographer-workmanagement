"use client";

import * as React from "react";
import { Check, Search, UserMinus } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, type ApiError } from "@/lib/api-client";
import type { UserRef } from "@/lib/types";
import { cn } from "@/lib/utils";
import { firstFieldErrors, useMutationRunner, type FieldErrors } from "./mutation";
import { useUserOptions, type UserOption } from "./use-user-options";
import { WorkloadBand } from "./workload-band";

/** Sentinel for "unassign". */
const UNASSIGN = "__unassign__";

export interface AssignEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  version: number;
  /** Who holds the job now (marked "Current"; enables Unassign). */
  current: UserRef | null;
  /** Assign the editor (default) or the photographer. */
  role?: "editor" | "photographer";
  jobLabel?: string;
  /** Context line, e.g. "Assign an editor before starting." */
  notice?: React.ReactNode;
  /** Offer "Unassign" when someone is assigned (default true for editors). */
  allowUnassign?: boolean;
  onConflict?: (error: ApiError) => void;
  /** After a successful assignment (the page is refreshed automatically). */
  onAssigned?: (userId: string | null) => void;
}

/** Searchable people picker with workload bands; assigns / reassigns / unassigns with a reason. */
export function AssignEditorDialog(props: AssignEditorDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange} size="md">
      {props.open ? <AssignForm {...props} /> : null}
    </Dialog>
  );
}

function AssignForm({
  onOpenChange,
  jobId,
  version,
  current,
  role = "editor",
  jobLabel,
  notice,
  allowUnassign = role === "editor",
  onConflict,
  onAssigned,
}: AssignEditorDialogProps) {
  const run = useMutationRunner();
  // Every active person of the role — NOT `{ jobId }`, which keeps only people who can
  // already view the job (the @mention list) and so would hide every new candidate.
  const people = useUserOptions(role);
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  const [errors, setErrors] = React.useState<FieldErrors | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement>(null);

  const noun = role === "editor" ? "editor" : "photographer";
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? people.options.filter((o) => o.name.toLowerCase().includes(q)) : people.options;
    // Current holder first, then healthiest band, then fewest active jobs.
    const bandRank = { healthy: 0, near_capacity: 1, overloaded: 2 } as const;
    return [...list].sort((a, b) => {
      if (a.id === current?.id) return -1;
      if (b.id === current?.id) return 1;
      const ba = a.band ? bandRank[a.band] : 3;
      const bb = b.band ? bandRank[b.band] : 3;
      if (ba !== bb) return ba - bb;
      return (a.activeJobs ?? 0) - (b.activeJobs ?? 0) || a.name.localeCompare(b.name);
    });
  }, [people.options, query, current?.id]);

  const isReassign = Boolean(current);
  const target = selected === UNASSIGN ? null : selected;
  const unchanged = selected === null || (target !== null && target === current?.id);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (unchanged) return;
    setSubmitting(true);
    setErrors(null);
    const picked = people.options.find((o) => o.id === target);
    const result = await run(
      () =>
        api.post(`/api/jobs/${jobId}/assign`, {
          jobId,
          role,
          userId: target,
          reason: reason.trim() || null,
          expectedVersion: version,
        }),
      {
        success: target === null ? `${capital(noun)} unassigned` : isReassign ? `Reassigned to ${picked?.name ?? "new " + noun}` : `Assigned to ${picked?.name ?? noun}`,
        onConflict: (err) => {
          onOpenChange(false);
          onConflict?.(err);
        },
      },
    );
    setSubmitting(false);
    if (result.ok) {
      onOpenChange(false);
      onAssigned?.(target);
    } else if (result.fieldErrors) {
      setErrors(result.fieldErrors);
    }
  };

  const onListKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[role=radio]") ?? []);
    const index = items.findIndex((el) => el === document.activeElement);
    const next = items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    next?.focus();
  };

  const errorText = Object.values(firstFieldErrors(errors))[0];

  return (
    <form onSubmit={submit} noValidate className="contents">
      <DialogHeader>
        <DialogTitle>{isReassign ? `Reassign ${noun}` : `Assign ${noun}`}</DialogTitle>
        <DialogDescription>
          {jobLabel ? <span className="font-medium text-ink-secondary">{jobLabel}. </span> : null}
          {notice ?? (role === "editor"
            ? "Workload bands show who has room. Reassigning mid-edit keeps the history and hands the current stage to the new editor."
            : "Pick who shot or owns this job.")}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4 pb-5">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${noun}s…`}
          leading={<Search aria-hidden="true" />}
          aria-label={`Search ${noun}s`}
          data-autofocus
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              listRef.current?.querySelector<HTMLButtonElement>("[role=radio]")?.focus();
            }
          }}
        />
        <div
          ref={listRef}
          role="radiogroup"
          aria-label={`Choose ${noun}`}
          onKeyDown={onListKeyDown}
          className="-mx-1 max-h-[min(22rem,50dvh)] space-y-1 overflow-y-auto px-1 scrollbar-thin"
        >
          {people.loading ? (
            Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12 w-full rounded-md" />)
          ) : people.error ? (
            <p className="rounded-md border border-danger/25 bg-danger-soft/60 px-3 py-2 text-sm text-danger-fg">
              {people.error}{" "}
              <button type="button" className="underline underline-offset-2 focus-ring" onClick={people.reload}>
                Try again
              </button>
            </p>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-ink-muted">
              {query ? `No ${noun}s match “${query}”.` : `There are no active ${noun}s yet.`}
            </p>
          ) : (
            filtered.map((o) => (
              <PersonOption
                key={o.id}
                option={o}
                isCurrent={o.id === current?.id}
                selected={selected === o.id}
                onSelect={() => setSelected(o.id)}
              />
            ))
          )}
          {allowUnassign && current ? (
            <button
              type="button"
              role="radio"
              aria-checked={selected === UNASSIGN}
              onClick={() => setSelected(UNASSIGN)}
              className={cn(
                "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors focus-ring",
                selected === UNASSIGN ? "border-danger/40 bg-danger-soft/60 text-danger-fg" : "border-dashed border-border text-ink-secondary hover:bg-surface-muted",
              )}
            >
              <UserMinus aria-hidden="true" className="size-4" />
              <span className="flex-1">Unassign {current.name}</span>
              <span className="text-xs text-ink-subtle">Job goes back to Ready</span>
            </button>
          ) : null}
        </div>
        <FormField label="Reason" optional description="Shown in the job history and to the people involved.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={2000} placeholder={isReassign ? "e.g. Sarah is on leave until Monday" : undefined} />
        </FormField>
        {errorText ? (
          <p role="alert" className="text-sm text-danger">
            {errorText}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant={selected === UNASSIGN ? "danger" : "primary"} loading={submitting} disabled={unchanged}>
          {selected === UNASSIGN ? "Unassign" : isReassign ? "Reassign" : "Assign"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function PersonOption({ option, isCurrent, selected, onSelect }: { option: UserOption; isCurrent: boolean; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors focus-ring",
        selected ? "border-accent bg-accent-soft/60" : "border-transparent hover:bg-surface-muted",
      )}
    >
      <Avatar name={option.name} size="md" colour={option.avatarColour || undefined} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-ink">{option.name}</span>
          {isCurrent ? (
            <Badge size="sm" variant="accent">
              Current
            </Badge>
          ) : null}
        </span>
        <span className="mt-0.5 flex items-center gap-2 text-xs text-ink-muted">
          {option.activeJobs !== null ? <span className="numeric">{option.activeJobs} active</span> : null}
          {option.ratio !== null ? <span className="numeric">· {Math.round(option.ratio * 100)}% capacity</span> : null}
        </span>
      </span>
      {option.band ? <WorkloadBand band={option.band} ratio={option.ratio} size="sm" /> : null}
      {selected ? <Check aria-hidden="true" className="size-4 shrink-0 text-accent-ink" /> : null}
    </button>
  );
}
