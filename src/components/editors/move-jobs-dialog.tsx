"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRightLeft, Check } from "lucide-react";
import { EditorDeskLine } from "@/components/job-simple/assign-editor-dialog";
import { simpleJobApi } from "@/components/job-simple/api";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/api-client";
import type { EditorPickerOption, UserRef } from "@/lib/types";
import { cn, pluralise } from "@/lib/utils";

export interface MoveJobsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  from: UserRef;
  /** The jobs on their desk right now (the ones that move). */
  jobs: ReadonlyArray<{ id: string; version: number; name: string }>;
  options: EditorPickerOption[];
}

/**
 * "Move their jobs to…" (docs/SIMPLIFICATION-PLAN.md §7): every job on this editor's desk goes to one
 * other editor. Each job is its own recorded Change editor (the same action as on the job page), so a
 * single stale row never blocks the rest and every hand-over is in the history.
 */
export function MoveJobsDialog({ open, onOpenChange, from, jobs, options }: MoveJobsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="md">
      {open ? <MoveForm onOpenChange={onOpenChange} from={from} jobs={jobs} options={options} /> : null}
    </Dialog>
  );
}

function MoveForm({ onOpenChange, from, jobs, options }: Omit<MoveJobsDialogProps, "open">) {
  const router = useRouter();
  const [target, setTarget] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const candidates = React.useMemo(
    () => options.filter((o) => o.editor.id !== from.id && o.editor.isActive).sort((a, b) => a.onDesk - b.onDesk || a.late - b.late || a.editor.name.localeCompare(b.editor.name)),
    [options, from.id],
  );
  const picked = candidates.find((c) => c.editor.id === target) ?? null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!picked || submitting) return;
    setSubmitting(true);
    let moved = 0;
    const failed: string[] = [];
    for (const job of jobs) {
      try {
        await simpleJobApi.changeEditor(job.id, { expectedVersion: job.version, editorId: picked.editor.id });
        moved += 1;
      } catch (err) {
        failed.push(`${job.name}: ${errorMessage(err)}`);
      }
      setProgress(moved + failed.length);
    }
    setSubmitting(false);
    if (failed.length === 0) {
      toast.success(`Moved ${pluralise(moved, "job")} to ${picked.editor.name}`);
    } else {
      toast({
        title: moved > 0 ? `Moved ${pluralise(moved, "job")}; ${pluralise(failed.length, "job")} did not move` : "Nothing moved",
        description: failed.slice(0, 3).join(" · ") + (failed.length > 3 ? ` · and ${failed.length - 3} more` : ""),
        variant: "warning",
        duration: 0,
      });
    }
    router.refresh();
    onOpenChange(false);
  };

  return (
    <form onSubmit={submit} noValidate className="contents">
      <DialogHeader>
        <DialogTitle>Move their jobs to…</DialogTitle>
        <DialogDescription>
          {pluralise(jobs.length, "job")} on <span className="font-medium text-ink-secondary">{from.name}</span>&rsquo;s desk will go to the editor you pick. They are told straight away; the history keeps both names.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-2 pb-5">
        {candidates.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-ink-muted">There is no other editor to move these jobs to. Invite one from Settings → People.</p>
        ) : (
          <div role="radiogroup" aria-label="Move to" className="-mx-1 max-h-[min(22rem,50dvh)] space-y-1 overflow-y-auto px-1">
            {candidates.map((row) => {
              const selected = row.editor.id === target;
              return (
                <button
                  key={row.editor.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setTarget(row.editor.id)}
                  className={cn("flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors focus-ring", selected ? "border-accent bg-accent-soft/60" : "border-transparent hover:bg-surface-muted")}
                >
                  <Avatar name={row.editor.name} size="md" colour={row.editor.avatarColour || undefined} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-ink">{row.editor.name}</span>
                      {row.full ? (
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
            })}
          </div>
        )}
        {submitting ? (
          <p className="text-xs text-ink-muted numeric" aria-live="polite">
            Moving {progress} of {jobs.length}…
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" leadingIcon={<ArrowRightLeft aria-hidden="true" />} loading={submitting} disabled={!picked || jobs.length === 0}>
          Move {pluralise(jobs.length, "job")}
        </Button>
      </DialogFooter>
    </form>
  );
}
