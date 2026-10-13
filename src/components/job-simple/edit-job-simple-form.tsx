"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ConflictDialog } from "@/components/jobs";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DateInput } from "@/components/ui/date-input";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { api, ApiError, errorMessage } from "@/lib/api-client";
import { isRushPriority, priorityForRush, type Priority } from "@/lib/constants";
import { civilDate } from "@/lib/dates";
import { pluralise } from "@/lib/utils";

export interface SimpleEditableJob {
  id: string;
  jobNumber: string;
  version: number;
  name: string;
  description: string | null;
  clientName: string;
  jobTypeId: string;
  priority: Priority;
  shootDate: string | null;
  dueDate: string | null;
  deliveryDueDate: string | null;
}

export interface SimpleEditPermissions {
  /** name, instructions, type of shoot, shoot date. */
  fields: boolean;
  /** due date, client delivery date. */
  deadlines: boolean;
  /** the Rush tick. */
  rush: boolean;
}

export interface EditJobSimpleFormProps {
  job: SimpleEditableJob;
  permissions: SimpleEditPermissions;
  timeZone: string;
  jobTypes: { id: string; name: string; archived: boolean }[];
  /** The client uses the portal: show the client delivery date. */
  clientHasPortal: boolean;
}

const civil = (iso: string | null, tz: string) => (iso ? (civilDate(new Date(Date.parse(iso) - 1), tz) ?? "") : "");

/**
 * Edit details (plan §5): the simple fields only — address / job name, type
 * of shoot, shoot date, due date, client delivery date (portal clients), Rush
 * job and the instructions. Sends only what changed with the job's version.
 */
export function EditJobSimpleForm({ job, permissions, timeZone, jobTypes, clientHasPortal }: EditJobSimpleFormProps) {
  const router = useRouter();
  const initial = React.useMemo(
    () => ({
      name: job.name,
      description: job.description ?? "",
      jobTypeId: job.jobTypeId,
      rush: isRushPriority(job.priority),
      shootDate: civil(job.shootDate, timeZone),
      dueDate: civil(job.dueDate, timeZone),
      deliveryDueDate: civil(job.deliveryDueDate, timeZone),
    }),
    [job, timeZone],
  );
  const [form, setForm] = React.useState(initial);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [conflict, setConflict] = React.useState<ApiError | null>(null);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => (key in e ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== key)) : e));
  };

  const changes = React.useMemo(() => {
    const out: Record<string, unknown> = {};
    if (permissions.fields) {
      if (form.name.trim() !== initial.name) out.name = form.name.trim();
      if ((form.description.trim() || null) !== (initial.description.trim() || null)) out.description = form.description.trim() || null;
      if (form.jobTypeId !== initial.jobTypeId) out.jobTypeId = form.jobTypeId;
      if (form.shootDate !== initial.shootDate) out.shootDate = form.shootDate || null;
    }
    if (permissions.deadlines) {
      if (form.dueDate !== initial.dueDate) out.dueDate = form.dueDate || null;
      if (clientHasPortal && form.deliveryDueDate !== initial.deliveryDueDate) out.deliveryDueDate = form.deliveryDueDate || null;
    }
    if (permissions.rush && form.rush !== initial.rush) out.priority = priorityForRush(form.rush);
    return out;
  }, [form, initial, permissions, clientHasPortal]);
  const count = Object.keys(changes).length;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (permissions.fields && !form.name.trim()) {
      setErrors({ name: "The job needs an address or name" });
      return;
    }
    if (count === 0) {
      toast.info("Nothing to save", "No fields were changed.");
      return;
    }
    setBusy(true);
    try {
      await api.patch(`/api/jobs/${job.id}`, { expectedVersion: job.version, ...changes });
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.isConflict) {
        setConflict(err);
        return;
      }
      if (err instanceof ApiError && err.code === "validation" && Object.keys(err.fieldErrors).length > 0) {
        setErrors(Object.fromEntries(Object.entries(err.fieldErrors).map(([k, v]) => [k, v[0] ?? "Check this field"])));
        toast.error("Check the highlighted fields");
        return;
      }
      toast.error("Changes not saved", errorMessage(err));
      return;
    }
    toast.success(`${job.jobNumber} updated`, `${pluralise(count, "change")} saved and recorded in the history.`);
    router.push(`/jobs/${job.id}`);
    router.refresh();
  };

  const lock = (ok: boolean) => (ok ? undefined : "Only the job's photographer or the studio owner can change this.");

  return (
    <>
      <form onSubmit={submit} noValidate aria-label={`Edit ${job.jobNumber}`} className="flex flex-col gap-5">
        <FormField label="Address / job name" required error={errors.name} description={lock(permissions.fields)}>
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={200} disabled={busy || !permissions.fields} autoComplete="off" />
        </FormField>
        <FormField label="Client" description="To move the job to another client, create a new job.">
          <Input value={job.clientName} readOnly disabled />
        </FormField>
        <div className="grid gap-5 sm:grid-cols-2">
          <FormField label="Type of shoot" error={errors.jobTypeId}>
            <Select value={form.jobTypeId} onChange={(e) => set("jobTypeId", e.target.value)} disabled={busy || !permissions.fields}>
              {jobTypes.map((t) => (
                <option key={t.id} value={t.id} disabled={t.archived && t.id !== job.jobTypeId}>
                  {t.name}
                  {t.archived ? " (archived)" : ""}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Shoot date" optional error={errors.shootDate}>
            <DateInput value={form.shootDate} onChange={(e) => set("shootDate", e.target.value)} disabled={busy || !permissions.fields} />
          </FormField>
          <FormField label="Due date" optional error={errors.dueDate} description={permissions.deadlines ? "When the editor should send it for checking." : lock(false)}>
            <DateInput value={form.dueDate} onChange={(e) => set("dueDate", e.target.value)} disabled={busy || !permissions.deadlines} />
          </FormField>
          {clientHasPortal ? (
            <FormField label="Client delivery date" optional error={errors.deliveryDueDate} description="Shown to the client in their portal.">
              <DateInput value={form.deliveryDueDate} onChange={(e) => set("deliveryDueDate", e.target.value)} disabled={busy || !permissions.deadlines} />
            </FormField>
          ) : null}
        </div>
        <Checkbox checked={form.rush} onChange={(e) => set("rush", e.target.checked)} disabled={busy || !permissions.rush} label="Rush job" description="Shows a Rush badge everywhere this job appears." />
        <FormField label="Instructions for the editor" optional error={errors.description}>
          <Textarea value={form.description} onChange={(e) => set("description", e.target.value)} rows={5} maxLength={5000} disabled={busy || !permissions.fields} placeholder="Style, must-have shots, what to leave out…" />
        </FormField>

        <div className="sticky bottom-[calc(var(--tabbar-height,0px)+env(safe-area-inset-bottom,0px))] z-(--z-page-sticky) -mx-4 mt-1 flex flex-wrap items-center gap-3 border-t border-border bg-canvas/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:bottom-0 lg:mx-0 lg:px-0">
          <span className="text-sm text-ink-muted" aria-live="polite">
            {count > 0 ? (
              <>
                <span className="numeric font-medium text-ink">{count}</span> unsaved {count === 1 ? "change" : "changes"}
              </>
            ) : (
              "No changes yet"
            )}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" href={`/jobs/${job.id}`} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={count === 0 && !busy}>
              Save changes
            </Button>
          </div>
        </div>
      </form>
      <ConflictDialog open={conflict !== null} onOpenChange={(open) => (open ? undefined : setConflict(null))} error={conflict} entity="job" timeZone={timeZone} />
    </>
  );
}
