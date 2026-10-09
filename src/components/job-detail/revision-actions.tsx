"use client";

import * as React from "react";
import { MessageSquareReply, Pencil, Undo2 } from "lucide-react";
import { ConflictDialog, ReasonDialog, toDialogResult, useMutationRunner, useUserOptions, firstFieldErrors } from "@/components/jobs";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, type ApiError } from "@/lib/api-client";
import { PRIORITIES, PRIORITY_META, WORKLOAD_BAND_META, type Priority } from "@/lib/constants";
import { civilDate } from "@/lib/dates";
import type { RevisionView } from "@/lib/types";

export interface RevisionActionsProps {
  jobId: string;
  /** The JOB's version (withdraw is a status move). */
  jobVersion: number;
  revision: RevisionView;
  canEdit: boolean;
  canWithdraw: boolean;
  canRespond: boolean;
  timeZone: string;
}

function EditRevisionForm({ revision, timeZone, onClose }: { revision: RevisionView; timeZone: string; onClose: () => void }) {
  const run = useMutationRunner();
  const people = useUserOptions("editor");
  const [assignee, setAssignee] = React.useState(revision.assignee?.id ?? "");
  const [instructions, setInstructions] = React.useState(revision.instructions ?? "");
  const [priority, setPriority] = React.useState<Priority>(revision.priority);
  const [due, setDue] = React.useState(revision.dueDate ? (civilDate(revision.dueDate, timeZone) ?? "") : "");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  const options = React.useMemo(() => {
    const list = people.options.map((p) => ({
      value: p.id,
      label: `${p.name}${p.band ? ` · ${WORKLOAD_BAND_META[p.band].label}` : ""}${p.activeJobs !== null ? ` · ${p.activeJobs} active` : ""}`,
    }));
    if (revision.assignee && !list.some((o) => o.value === revision.assignee?.id)) list.unshift({ value: revision.assignee.id, label: revision.assignee.name });
    return list;
  }, [people.options, revision.assignee]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const body: Record<string, unknown> = {};
    if ((revision.assignee?.id ?? "") !== assignee) body.assigneeUserId = assignee || null;
    if ((revision.instructions ?? "") !== instructions.trim()) body.instructions = instructions.trim() || null;
    if (revision.priority !== priority) body.priority = priority;
    const currentDue = revision.dueDate ? (civilDate(revision.dueDate, timeZone) ?? "") : "";
    if (currentDue !== due) body.dueDate = due || null;
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    const result = await run(() => api.patch(`/api/revisions/${revision.id}`, body), { success: `Revision #${revision.revisionNumber} updated` });
    setBusy(false);
    if (result.ok) onClose();
    else if (result.fieldErrors) setErrors(firstFieldErrors(result.fieldErrors));
  };

  return (
    <form onSubmit={submit} noValidate className="contents">
      <DialogHeader>
        <DialogTitle>Edit revision #{revision.revisionNumber}</DialogTitle>
        <DialogDescription>Reason and description stay as requested; every change here is recorded in the job history.</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4 pb-5">
        <FormField label="Assigned to" error={errors.assigneeUserId} description={people.error ?? undefined}>
          <Select value={assignee} onChange={(e) => setAssignee(e.target.value)} disabled={people.loading && options.length === 0}>
            <option value="">No assignee</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Instructions" optional error={errors.instructions}>
          <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={4} maxLength={5000} placeholder="Specific steps for the editor…" />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Priority" error={errors.priority}>
            <Select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_META[p].label }))} />
          </FormField>
          <FormField label="Due" optional error={errors.dueDate}>
            <DateInput value={due} onChange={(e) => setDue(e.target.value)} />
          </FormField>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" loading={busy}>
          Save changes
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Actions on an open revision: edit (managers / photographer), withdraw, respond. */
export function RevisionActions({ jobId, jobVersion, revision, canEdit, canWithdraw, canRespond, timeZone }: RevisionActionsProps) {
  const run = useMutationRunner();
  const [editOpen, setEditOpen] = React.useState(false);
  const [withdrawOpen, setWithdrawOpen] = React.useState(false);
  const [conflict, setConflict] = React.useState<ApiError | null>(null);

  if (!canEdit && !canWithdraw && !canRespond) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canRespond ? (
        <Button href={`/jobs/${jobId}?tab=comments&respond=${revision.id}`} variant="outline" size="sm" leadingIcon={<MessageSquareReply aria-hidden="true" />}>
          Respond
        </Button>
      ) : null}
      {canEdit ? (
        <Button variant="outline" size="sm" leadingIcon={<Pencil aria-hidden="true" />} onClick={() => setEditOpen(true)}>
          Edit
        </Button>
      ) : null}
      {canWithdraw ? (
        <Button variant="ghost" size="sm" leadingIcon={<Undo2 aria-hidden="true" />} onClick={() => setWithdrawOpen(true)}>
          Withdraw
        </Button>
      ) : null}

      <Dialog open={editOpen} onOpenChange={setEditOpen} size="md">
        {editOpen ? <EditRevisionForm revision={revision} timeZone={timeZone} onClose={() => setEditOpen(false)} /> : null}
      </Dialog>

      <ReasonDialog
        open={withdrawOpen}
        onOpenChange={setWithdrawOpen}
        title={`Withdraw revision #${revision.revisionNumber}?`}
        description="The job returns to the status it was in when the revision was requested. The revision stays numbered in the history as withdrawn."
        required={false}
        label="Note"
        placeholder="Optional — why it is no longer needed"
        confirmLabel="Withdraw revision"
        onSubmit={async (note) => {
          const result = await run(() => api.post(`/api/revisions/${revision.id}/withdraw`, { expectedVersion: jobVersion, note: note || null }), {
            success: `Revision #${revision.revisionNumber} withdrawn`,
            onConflict: setConflict,
          });
          return toDialogResult(result);
        }}
      />
      <ConflictDialog open={conflict !== null} onOpenChange={(open) => (!open ? setConflict(null) : undefined)} error={conflict ?? undefined} timeZone={timeZone} />
    </div>
  );
}
