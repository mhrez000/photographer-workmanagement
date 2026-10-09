"use client";

import * as React from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, type ApiError } from "@/lib/api-client";
import { PRIORITIES, PRIORITY_META, REVISION_REASON_SUGGESTIONS, WORKLOAD_BAND_META, type Priority } from "@/lib/constants";
import { todayCivil } from "@/lib/dates";
import type { UserRef } from "@/lib/types";
import { cn } from "@/lib/utils";
import { firstFieldErrors, useMutationRunner, type FieldErrors } from "./mutation";
import { useUserOptions } from "./use-user-options";

export interface RevisionRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  /** Job version for optimistic concurrency. */
  version: number;
  /** "PJ-0042 · 123 Smith Street" for the header. */
  jobLabel?: string;
  /** Default assignee (the job's current editor). */
  currentEditor: UserRef | null;
  /** Specific revision status (from JobAvailableActions); omitted → category "revision". */
  toStatusId?: string;
  /** Reopening a completed job for revision (the reason is also the reopen reason). */
  isReopen?: boolean;
  defaultPriority?: Priority;
  /** Org timezone (civil "today" for the due-date picker). */
  timeZone?: string;
  onConflict?: (error: ApiError) => void;
  /** Called after a successful request (the page is refreshed automatically). */
  onDone?: () => void;
}

interface FormState {
  reason: string;
  description: string;
  instructions: string;
  priority: Priority;
  dueDate: string;
  assigneeUserId: string;
}

/** Request a revision: reason chips + text, description, instructions, priority, due date, assignee. */
export function RevisionRequestDialog(props: RevisionRequestDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange} size="md">
      {props.open ? <RevisionForm {...props} /> : null}
    </Dialog>
  );
}

function pick(errors: FieldErrors | null, ...keys: string[]): string | undefined {
  const flat = firstFieldErrors(errors);
  for (const k of keys) if (flat[k]) return flat[k];
  return undefined;
}

function RevisionForm({
  onOpenChange,
  jobId,
  version,
  jobLabel,
  currentEditor,
  toStatusId,
  isReopen = false,
  defaultPriority = "normal",
  timeZone,
  onConflict,
  onDone,
}: RevisionRequestDialogProps) {
  const run = useMutationRunner();
  // Any active editor may take the revision (not only those who can already view the job).
  const people = useUserOptions("editor");
  const [form, setForm] = React.useState<FormState>({
    reason: "",
    description: "",
    instructions: "",
    priority: defaultPriority,
    dueDate: "",
    assigneeUserId: "",
  });
  const [errors, setErrors] = React.useState<FieldErrors | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  // "" = keep the current editor (the engine defaults the assignee to job.editorId).
  const editorOptions = React.useMemo(
    () => [
      { value: "", label: currentEditor ? `${currentEditor.name} (current editor)` : "No editor — assign later" },
      ...people.options
        .filter((o) => o.id !== currentEditor?.id)
        .map((o) => ({
          value: o.id,
          label: `${o.name}${o.band ? ` · ${WORKLOAD_BAND_META[o.band].emoji} ${WORKLOAD_BAND_META[o.band].label}` : ""}${o.activeJobs !== null ? ` · ${o.activeJobs} active` : ""}`,
        })),
    ],
    [people.options, currentEditor],
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const local: FieldErrors = {};
    if (!form.reason.trim()) local.reason = ["Pick or type a reason"];
    if (!form.description.trim()) local.description = ["Describe what needs to change"];
    if (Object.keys(local).length > 0) {
      setErrors(local);
      return;
    }
    setSubmitting(true);
    setErrors(null);
    const revision = {
      reason: form.reason.trim(),
      description: form.description.trim(),
      instructions: form.instructions.trim() || null,
      priority: form.priority,
      dueDate: form.dueDate || null,
      assigneeUserId: form.assigneeUserId || null,
    };
    const result = await run(
      () =>
        api.post(`/api/jobs/${jobId}/transition`, {
          jobId,
          expectedVersion: version,
          ...(toStatusId ? { toStatusId } : { toCategory: "revision" }),
          reason: isReopen ? revision.reason : undefined,
          revision,
        }),
      {
        success: isReopen ? "Job reopened for revision" : "Revision requested",
        successDescription: "The editor has been notified.",
        onConflict: (err) => {
          onOpenChange(false);
          onConflict?.(err);
        },
      },
    );
    setSubmitting(false);
    if (result.ok) {
      onOpenChange(false);
      onDone?.();
    } else if (result.fieldErrors) {
      setErrors(result.fieldErrors);
    }
  };

  const today = todayCivil(timeZone);
  const unknownErrors = Object.entries(firstFieldErrors(errors)).filter(
    ([k]) => !["reason", "description", "instructions", "priority", "dueDate", "assigneeUserId"].includes(k.replace(/^revision\./, "")),
  );

  return (
    <form onSubmit={submit} noValidate className="contents">
      <DialogHeader>
        <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-status-revision-soft text-status-revision-fg">
          <RotateCcw aria-hidden="true" className="size-5" />
        </div>
        <DialogTitle>{isReopen ? "Reopen for revision" : "Request a revision"}</DialogTitle>
        <DialogDescription>
          {jobLabel ? <span className="font-medium text-ink-secondary">{jobLabel}. </span> : null}
          The revision is numbered and kept in the job history — earlier revisions are never overwritten.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-5 pb-5">
        <FormField label="Reason" required error={pick(errors, "reason", "revision.reason")}>
          {(field) => (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Common reasons">
                {REVISION_REASON_SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={form.reason === s}
                    onClick={() => set("reason", s)}
                    className={cn(
                      "h-7 rounded-full border px-2.5 text-xs transition-colors focus-ring",
                      form.reason === s
                        ? "border-status-revision bg-status-revision-soft text-status-revision-fg"
                        : "border-border bg-surface text-ink-secondary hover:bg-surface-muted",
                    )}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <Input
                {...field}
                value={form.reason}
                onChange={(e) => set("reason", e.target.value)}
                placeholder="Or type your own reason"
                data-autofocus
                maxLength={200}
                invalid={Boolean(pick(errors, "reason", "revision.reason"))}
              />
            </div>
          )}
        </FormField>
        <FormField label="What needs to change" required error={pick(errors, "description", "revision.description")}>
          <Textarea
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder="e.g. Sky replacement on images 4, 7 and 12 looks unnatural."
            rows={3}
            maxLength={5000}
          />
        </FormField>
        <FormField label="Specific instructions" optional error={pick(errors, "instructions", "revision.instructions")}>
          <Textarea
            value={form.instructions}
            onChange={(e) => set("instructions", e.target.value)}
            placeholder="Step-by-step notes, references, client wording…"
            rows={2}
            maxLength={5000}
          />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Priority" error={pick(errors, "priority", "revision.priority")}>
            <Select
              value={form.priority}
              onChange={(e) => set("priority", e.target.value as Priority)}
              options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_META[p].label }))}
            />
          </FormField>
          <FormField label="Revision due" optional error={pick(errors, "dueDate", "revision.dueDate")}>
            <DateInput value={form.dueDate} min={today} onChange={(e) => set("dueDate", e.target.value)} />
          </FormField>
        </div>
        <FormField
          label="Assign to"
          description={people.error ? "Could not load editors — the current editor will be used." : "Defaults to the editor who did the work."}
          error={pick(errors, "assigneeUserId", "revision.assigneeUserId")}
        >
          <Select
            value={form.assigneeUserId}
            onChange={(e) => set("assigneeUserId", e.target.value)}
            options={editorOptions}
            disabled={people.loading}
          />
        </FormField>
        {unknownErrors.length > 0 ? (
          <ul role="alert" className="rounded-md border border-danger/25 bg-danger-soft/60 px-3 py-2 text-sm text-danger-fg">
            {unknownErrors.map(([k, m]) => (
              <li key={k}>{m}</li>
            ))}
          </ul>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" loading={submitting}>
          {isReopen ? "Reopen for revision" : "Request revision"}
        </Button>
      </DialogFooter>
    </form>
  );
}
