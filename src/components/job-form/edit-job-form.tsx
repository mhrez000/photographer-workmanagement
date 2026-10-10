"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Lock, RotateCcw } from "lucide-react";
import { ConflictDialog, jobHref } from "@/components/jobs";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { api, ApiError, errorMessage } from "@/lib/api-client";
import { PRIORITIES, PRIORITY_META, type Priority } from "@/lib/constants";
import type { ClientOption, JobTypeView, ProjectOption } from "@/lib/types";
import { cn, pluralise } from "@/lib/utils";
import { FormSection } from "./form-section";
import { dateWarnings, fromCivilInput, hoursError, parseHours, pickErrors, toCivilInput } from "./form-utils";
import { SubmitHint, formKeyDown, useUnsavedChangesWarning } from "./submit-hint";
import { useClientProject } from "./use-client-project";

/** The editable slice of a job (from `JobDetail.job`). */
export interface EditableJob {
  id: string;
  jobNumber: string;
  version: number;
  name: string;
  description: string | null;
  clientId: string;
  projectId: string;
  jobTypeId: string;
  workflowName: string | null;
  priority: Priority;
  shootDate: string | null;
  dueDate: string | null;
  reviewDueDate: string | null;
  deliveryDueDate: string | null;
  estimatedHours: number | null;
  completionPercent: number;
}

/** Per-field-group permissions (from `JobDetail.actions` + `job.edit_completion_percent`). */
export interface EditPermissions {
  /** name, description, job type, shoot date, estimated hours (`job.edit_fields`). */
  fields: boolean;
  /** client / project (`job.change_client`, docs/ROLES.md §4.5). Omitted = same as `fields`. */
  client?: boolean;
  /** due / review / delivery dates (`job.set_*_date`). */
  deadlines: boolean;
  priority: boolean;
  completion: boolean;
}

export interface EditJobFormProps {
  job: EditableJob;
  permissions: EditPermissions;
  timeZone: string;
  jobTypes: JobTypeView[];
  clients: ClientOption[];
  /** Projects of the job's client. */
  projects: ProjectOption[];
  canCreateClient: boolean;
  canCreateProject: boolean;
}

type DateKey = "shootDate" | "dueDate" | "reviewDueDate" | "deliveryDueDate";

const PRIORITY_OPTIONS = PRIORITIES.map((p) => ({ value: p, label: PRIORITY_META[p].label }));
const LOCKED_FIELDS = "Only the job's photographer, its creator or the studio owner can change this.";

function Locked({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-ink-subtle">
      <Lock aria-hidden="true" className="size-3" /> Read-only
    </span>
  );
}

/**
 * Edit job fields (ARCHITECTURE §10 `/jobs/[id]/edit`). Sends only the
 * changed fields with the job's version as `expectedVersion`; fields the
 * actor may not change are shown read-only. 409 → ConflictDialog.
 */
export function EditJobForm({ job, permissions, timeZone, jobTypes, clients, projects, canCreateClient, canCreateProject }: EditJobFormProps) {
  const router = useRouter();
  const formRef = React.useRef<HTMLFormElement>(null);
  const initialDates = React.useMemo(
    () => ({
      shootDate: toCivilInput(job.shootDate, timeZone),
      dueDate: toCivilInput(job.dueDate, timeZone),
      reviewDueDate: toCivilInput(job.reviewDueDate, timeZone),
      deliveryDueDate: toCivilInput(job.deliveryDueDate, timeZone),
    }),
    [job.shootDate, job.dueDate, job.reviewDueDate, job.deliveryDueDate, timeZone],
  );
  const initialHours = job.estimatedHours === null ? "" : String(job.estimatedHours);

  const [name, setName] = React.useState(job.name);
  const [description, setDescription] = React.useState(job.description ?? "");
  const [jobTypeId, setJobTypeId] = React.useState(job.jobTypeId);
  const [priority, setPriority] = React.useState<Priority>(job.priority);
  const [dates, setDates] = React.useState(initialDates);
  const [hours, setHours] = React.useState(initialHours);
  const [completion, setCompletion] = React.useState(job.completionPercent);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [conflict, setConflict] = React.useState<ApiError | null>(null);

  const canChangeClient = permissions.client ?? permissions.fields;
  const clientProject = useClientProject({
    clients,
    projects,
    initialClientId: job.clientId,
    initialProjectId: job.projectId,
    canCreateClient: canCreateClient && canChangeClient,
    canCreateProject: canCreateProject && canChangeClient,
    disabled: busy || !canChangeClient,
    errors: { clientId: errors.clientId, projectId: errors.projectId },
    onChange: () => clearError("clientId", "projectId"),
  });

  function clearError(...keys: string[]) {
    setErrors((prev) => {
      if (!keys.some((k) => k in prev)) return prev;
      const next = { ...prev };
      for (const k of keys) delete next[k];
      return next;
    });
  }

  /** Only the fields that differ from the loaded job (and that the actor may change). */
  const changes = React.useMemo(() => {
    const out: Record<string, unknown> = {};
    if (permissions.fields) {
      if (name.trim() !== job.name) out.name = name.trim();
      const desc = description.trim() || null;
      if (desc !== (job.description?.trim() || null)) out.description = desc;
      if (canChangeClient && clientProject.projectId !== job.projectId && clientProject.projectId) {
        out.projectId = clientProject.projectId;
        if (clientProject.clientId) out.clientId = clientProject.clientId;
      }
      if (jobTypeId !== job.jobTypeId) out.jobTypeId = jobTypeId;
      if (dates.shootDate !== initialDates.shootDate) out.shootDate = fromCivilInput(dates.shootDate);
      if (hours.trim() !== initialHours) {
        const h = parseHours(hours);
        if (!(h !== null && !Number.isNaN(h) && h === job.estimatedHours)) out.estimatedHours = h;
      }
    }
    if (permissions.deadlines) {
      for (const key of ["dueDate", "reviewDueDate", "deliveryDueDate"] as const) {
        if (dates[key] !== initialDates[key]) out[key] = fromCivilInput(dates[key]);
      }
    }
    if (permissions.priority && priority !== job.priority) out.priority = priority;
    if (permissions.completion && completion !== job.completionPercent) out.completionPercent = completion;
    return out;
  }, [permissions, canChangeClient, name, description, clientProject.projectId, clientProject.clientId, jobTypeId, dates, hours, priority, completion, job, initialDates, initialHours]);

  const changeCount = Object.keys(changes).length;
  const clientChangedWithoutProject = canChangeClient && clientProject.clientId !== job.clientId && !clientProject.projectId;
  useUnsavedChangesWarning(changeCount > 0 && !busy && !saved);

  const reset = () => {
    setName(job.name);
    setDescription(job.description ?? "");
    setJobTypeId(job.jobTypeId);
    setPriority(job.priority);
    setDates(initialDates);
    setHours(initialHours);
    setCompletion(job.completionPercent);
    setErrors({});
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const local: Record<string, string> = {};
    if (permissions.fields && !name.trim()) local.name = "The job needs a name";
    if (clientChangedWithoutProject) local.projectId = "Choose a project of the new client";
    const h = permissions.fields ? hoursError(hours) : null;
    if (h) local.estimatedHours = h;
    setErrors(local);
    if (Object.keys(local).length > 0) return;
    if (changeCount === 0) {
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
        setErrors(pickErrors(err.fieldErrors));
        toast.error("Check the highlighted fields");
        return;
      }
      toast.error("Changes not saved", errorMessage(err));
      return;
    }
    setSaved(true);
    toast.success(`${job.jobNumber} updated`, `${pluralise(changeCount, "change")} saved and recorded in the history.`);
    router.push(jobHref(job.id));
    router.refresh();
  };

  const jobType = jobTypes.find((t) => t.id === jobTypeId) ?? null;
  const warnings = dateWarnings(dates);
  const dateEditable = (key: DateKey) => (key === "shootDate" ? permissions.fields : permissions.deadlines);
  const changed = (key: string) => key in changes;
  const changedDot = (key: string) =>
    changed(key) ? <span className="inline-flex items-center gap-1 text-xs font-normal text-accent-ink"><span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />Changed</span> : null;

  return (
    <>
      <form ref={formRef} onSubmit={onSubmit} onKeyDown={formKeyDown} noValidate aria-label={`Edit ${job.jobNumber}`} className="min-w-0">
        <FormSection
          title="Details"
          description="Name, brief and where the job belongs."
          aside={<Locked show={!permissions.fields} />}
        >
          <FormField label="Job name" required error={errors.name} hint={changedDot("name")} description={!permissions.fields ? LOCKED_FIELDS : undefined}>
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                clearError("name");
              }}
              maxLength={200}
              disabled={busy || !permissions.fields}
              autoComplete="off"
            />
          </FormField>
          <FormField label="Description" optional error={errors.description} hint={changedDot("description")}>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} maxLength={5000} disabled={busy || !permissions.fields} />
          </FormField>
          <div className="grid gap-5 sm:grid-cols-2">{clientProject.fields}</div>
          <FormField
            label="Job type"
            error={errors.jobTypeId}
            hint={changedDot("jobTypeId")}
            description={
              jobTypeId !== job.jobTypeId
                ? `The job keeps its current workflow${job.workflowName ? ` (${job.workflowName})` : ""}; the new type applies to reporting and defaults.`
                : jobType
                  ? `Workflow: ${job.workflowName ?? jobType.workflow.name}`
                  : undefined
            }
          >
            <Select value={jobTypeId} onChange={(e) => setJobTypeId(e.target.value)} disabled={busy || !permissions.fields}>
              {jobTypes.map((t) => (
                <option key={t.id} value={t.id} disabled={t.archivedAt !== null && t.id !== job.jobTypeId}>
                  {t.name}
                  {t.archivedAt ? " (archived)" : ""}
                </option>
              ))}
            </Select>
          </FormField>
        </FormSection>

        <FormSection
          title="Schedule"
          description={`In the studio's timezone (${timeZone}). Clearing a date removes it; every change is kept in the history.`}
          aside={<Locked show={!permissions.deadlines && !permissions.fields} />}
        >
          <div className="grid gap-5 sm:grid-cols-2">
            {(
              [
                ["shootDate", "Shoot date"],
                ["dueDate", "Editing deadline"],
                ["reviewDueDate", "Review deadline"],
                ["deliveryDueDate", "Delivery date — visible to the client when shared"],
              ] as const
            ).map(([key, label]) => (
              <FormField key={key} label={label} optional error={errors[key]} hint={changedDot(key)} description={!dateEditable(key) ? "Read-only for you." : undefined}>
                <DateInput
                  value={dates[key]}
                  onChange={(e) => {
                    setDates((d) => ({ ...d, [key]: e.target.value }));
                    clearError(key);
                  }}
                  disabled={busy || !dateEditable(key)}
                />
              </FormField>
            ))}
          </div>
          {warnings.length > 0 ? (
            <ul className="flex flex-col gap-1 rounded-md border border-warning/25 bg-warning-soft/50 px-3 py-2 text-sm text-warning-fg" role="status">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
        </FormSection>

        <FormSection title="Priority & progress" description="Priority orders everyone's queues; completion is the editor's best estimate.">
          <FormField label="Priority" hint={changed("priority") ? changedDot("priority") : !permissions.priority ? <Locked show /> : null}>
            {(control) => (
              <SegmentedControl
                id={control.id}
                aria-label="Priority"
                options={PRIORITY_OPTIONS.map((o) => ({ ...o, disabled: busy || !permissions.priority }))}
                value={priority}
                onValueChange={(v) => setPriority(v)}
                className="self-start"
              />
            )}
          </FormField>
          <div className="grid gap-5 sm:grid-cols-2">
            <FormField label="Estimated hours" optional error={errors.estimatedHours} hint={changedDot("estimatedHours")}>
              <Input
                inputMode="decimal"
                value={hours}
                onChange={(e) => {
                  setHours(e.target.value);
                  clearError("estimatedHours");
                }}
                trailing="h"
                mono
                disabled={busy || !permissions.fields}
                autoComplete="off"
              />
            </FormField>
            <FormField label="Completion" error={errors.completionPercent} hint={changed("completionPercent") ? changedDot("completionPercent") : !permissions.completion ? <Locked show /> : null}>
              {(control) => (
                <div className="flex h-9 items-center gap-3">
                  <input
                    {...control}
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={completion}
                    onChange={(e) => setCompletion(Number(e.target.value))}
                    disabled={busy || !permissions.completion}
                    aria-valuetext={`${completion}%`}
                    className="h-1.5 min-w-0 flex-1 cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <span className={cn("w-12 text-right text-sm font-medium numeric", permissions.completion ? "text-ink" : "text-ink-muted")}>{completion}%</span>
                </div>
              )}
            </FormField>
          </div>
        </FormSection>

        <div className="sticky bottom-[calc(var(--tabbar-height,0px)+env(safe-area-inset-bottom,0px))] z-(--z-page-sticky) -mx-4 mt-2 flex flex-wrap items-center gap-3 border-t border-border bg-canvas/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:bottom-0 lg:mx-0 lg:px-0">
          <span className="text-sm text-ink-muted" aria-live="polite">
            {changeCount > 0 ? (
              <>
                <span className="numeric font-medium text-ink">{changeCount}</span> unsaved {changeCount === 1 ? "change" : "changes"}
              </>
            ) : (
              "No changes yet"
            )}
          </span>
          {changeCount > 0 ? (
            <Button variant="ghost" size="sm" leadingIcon={<RotateCcw />} onClick={reset} disabled={busy}>
              Reset
            </Button>
          ) : null}
          <SubmitHint action="save" className="hidden lg:inline" />
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" href={jobHref(job.id)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={changeCount === 0 && !busy}>
              Save changes
            </Button>
          </div>
        </div>
      </form>
      {clientProject.dialogs}
      <ConflictDialog open={conflict !== null} onOpenChange={(open) => (open ? undefined : setConflict(null))} error={conflict} entity="job" timeZone={timeZone} />
    </>
  );
}
